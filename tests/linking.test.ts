import { describe, expect, it, vi } from 'vitest';
import { MemoryMetadataIndex } from '../src/linking/metadata-index';
import { LocalMentionMatcher } from '../src/linking/mention-matcher';
import { ConfirmedLinkService } from '../src/linking/link-service';
import type { EditorSnapshot, LinkHost, LinkProposal } from '../src/linking/types';
import { context, target } from './helpers';

export function snapshot(text = '学习 Transformer 和注意力机制'): EditorSnapshot { return { sessionId: 'editor-one', noteId: 99, path: 'Inbox/source.md', revision: 1, contextFrom: 10, text, allowedRanges: [{ from: 10, to: 10 + text.length }], linkedNoteIds: new Set() }; }
describe('memory matching', () => {
  it('preserves Chinese and ASCII offsets, boundaries, and longest matches', () => {
    const index = new MemoryMetadataIndex(); index.upsert(target()); index.upsert(target(2, '注意力')); index.upsert(target(3, '注意力机制'));
    const text = 'xTransformer transformer 注意力机制'; const result = index.match(text, 7);
    expect(result.matches.map(match => match.text)).toEqual(['transformer', '注意力机制']); for (const match of result.matches) expect(text.slice(match.from - 7, match.to - 7)).toBe(match.text);
  });
  it('removes aliases incrementally without breaking shared prefixes', () => {
    const index = new MemoryMetadataIndex(); index.upsert(target(1, 'Transfer', { aliases: ['Transformer'] })); index.upsert(target(2, 'Transform')); index.upsert(target(1, 'Transfer'));
    expect(index.match('Transformer Transfer Transform').matches.map(match => match.text)).toEqual(['Transfer', 'Transform']); index.remove(1); expect(index.match('Transfer Transform').matches.map(match => match.text)).toEqual(['Transform']);
  });
  it('keeps the catalogue epoch stable for body or descriptive metadata updates', () => { const index = new MemoryMetadataIndex(); index.upsert(target()); const epoch = index.epoch; index.upsert(target(1, 'Transformer', { revision: 2, description: 'changed' })); expect(index.epoch).toBe(epoch); expect(index.get(1)?.revision).toBe(2); });
  it('does not split graphemes or match Latin substrings', () => { const index = new MemoryMetadataIndex(); index.upsert(target(1, 'cafe')); index.upsert(target(2, '👩')); expect(index.match('cafe\u0301 👩‍💻 xcafe').matches).toEqual([]); });
  it('limits common-term postings and raw hit count', () => { const index = new MemoryMetadataIndex(); for (let id = 0; id < 129; id++) index.upsert(target(id)); expect(index.match('Transformer')).toEqual({ matches: [], limited: true }); index.clear(); index.upsert(target(1, '词条')); const result = index.match('词条 '.repeat(200)); expect(result.limited).toBe(true); expect(result.matches.length).toBeLessThanOrEqual(128); });
  it('filters syntax ranges, self links and existing targets before making requests', () => {
    const index = new MemoryMetadataIndex(); index.upsert(target()); index.upsert(target(2, '注意力机制'));
    const matcher = new LocalMentionMatcher(index); const value = snapshot();
    expect(matcher.inputs({ ...value, linkedNoteIds: new Set([1]), allowedRanges: [{ from: 0, to: 1000 }] }, () => true).map(input => input.candidates[0]?.noteId)).toEqual([2]);
    expect(matcher.inputs({ ...value, allowedRanges: [] }, () => true)).toEqual([]);
  });
  it('abandons tied candidates beyond the shortlist boundary', () => { const index = new MemoryMetadataIndex(); for (let id = 0; id < 9; id++) index.upsert(target(id, 'Transformer', { path: `Folder${id}/Transformer.md` })); expect(new LocalMentionMatcher(index).inputs(snapshot('Transformer'), () => true)).toEqual([]); });
  it('never sends excluded syntax or private properties as neighboring context', () => { const index = new MemoryMetadataIndex(); index.upsert(target()); const value = snapshot('private-property\nTransformer'); const inputs = new LocalMentionMatcher(index).inputs({ ...value, allowedRanges: [{ from: 27, to: 38 }] }, () => true); expect(inputs[0]?.anchor.contextText).toBe('Transformer'); expect(inputs[0]?.anchor.contextFrom).toBe(27); });
});

describe('link insertion plans', () => {
  function fixture() {
    const index = new MemoryMetadataIndex(); index.upsert(target()); let current = snapshot('Transformer'); let text = ' '.repeat(10) + current.text; let style = 'wiki';
    const replace = vi.fn((from: number, to: number, value: string) => { text = text.slice(0, from) + value + text.slice(to); });
    const port = { snapshot: () => current, read: (from: number, to: number) => text.slice(from, to), allows: () => true, replace, replaceMany: (changes: readonly { from: number; to: number; replacement: string }[]) => { for (const change of [...changes].sort((a, b) => b.from - a.from)) replace(change.from, change.to, change.replacement); }, suppress: vi.fn() };
    const host: LinkHost = { editor: id => id === current.sessionId ? port : undefined, generateLink: () => style === 'wiki' ? '[[Resources/Transformer|Transformer]]' : '[Transformer](Resources/Transformer.md)', resolvesTo: () => true, allowed: () => true, settingsRevision: () => 0 };
    const input = new LocalMentionMatcher(index).inputs(current, () => true)[0]!;
    const proposal: LinkProposal = { id: 'suggestion', input, context, selected: 1 };
    return { service: new ConfirmedLinkService(index, host), proposal, index, replace, port, edit: () => { current = { ...current, revision: current.revision + 1 }; }, format: () => { style = 'markdown'; } };
  }
  it('does nothing until confirmation and inserts at the original UTF-16 span once', () => { const f = fixture(); const plan = f.service.prepare(f.proposal, 1); expect(f.replace).not.toHaveBeenCalled(); f.service.confirm(plan.id); expect(f.replace).toHaveBeenCalledWith(10, 21, '[[Resources/Transformer|Transformer]]'); expect(() => f.service.confirm(plan.id)).toThrow(); expect(f.replace).toHaveBeenCalledTimes(1); });
  it.each(['edit', 'rename', 'format'] as const)('rejects %s after the preview was prepared', change => { const f = fixture(); const plan = f.service.prepare(f.proposal, 1); if (change === 'edit') f.edit(); if (change === 'rename') f.index.upsert(target(1, 'Transformer', { path: 'New/Transformer.md', revision: 2 })); if (change === 'format') f.format(); expect(() => f.service.confirm(plan.id)).toThrow(); expect(f.replace).not.toHaveBeenCalled(); });
  it('does not allow a target outside the offered candidate set', () => { const f = fixture(); f.index.upsert(target(3, 'Other')); expect(() => f.service.prepare(f.proposal, 3)).toThrow(); });
});

describe('semantic link cache', () => {
  it.each(['n1', 'unassigned'])('reuses %s across 1000 unrelated edits and invalidates decisive changes', async selected => {
    const { JevLinkRecommender } = await import('../src/linking/recommender');
    const { answer, scope } = await import('./helpers');
    const evaluate = vi.fn(async (batch: import('../src/jev/types').ChoiceBatch) => answer(batch, () => selected));
    const recommender = new JevLinkRecommender({ evaluate } as unknown as import('../src/jev/types').DecisionScheduler);
    const index = new MemoryMetadataIndex(); index.upsert(target());
    const matcher = new LocalMentionMatcher(index);
    for (let revision = 0; revision < 1000; revision++) {
      const value = snapshot(`Unrelated field ${revision}.Transformer explains attention. Other unrelated content.`);
      const inputs = matcher.inputs({ ...value, revision }, () => true);
      await recommender.propose(inputs, context, scope());
    }
    expect(evaluate).toHaveBeenCalledTimes(1);
    await recommender.propose(matcher.inputs(snapshot('Transformer explains something else.'), () => true), context, scope());
    expect(evaluate).toHaveBeenCalledTimes(2);
    index.upsert(target(1, 'Transformer', { revision: 2 }));
    await recommender.propose(matcher.inputs(snapshot('Transformer explains something else.'), () => true), context, scope());
    expect(evaluate).toHaveBeenCalledTimes(3);
  });
});
