import { describe, expect, it } from 'vitest';
import { deriveTerms, inflections, isShortTerm, normalize, termsFor } from '../src/linking/terms';
import { MemoryMetadataIndex } from '../src/linking/metadata-index';
import { MemoryLinkGraph } from '../src/linking/link-graph';
import { LocalMentionMatcher, sentenceRange } from '../src/linking/mention-matcher';
import { searchTargets } from '../src/linking/target-search';
import type { ScanRequest } from '../src/linking/types';
import { target } from './helpers';

const texts = (index: MemoryMetadataIndex, text: string) => index.match(text).matches.map(match => match.text);
function request(text: string, extra: Partial<ScanRequest> = {}): ScanRequest {
  return { sourceNoteId: 99, sourcePath: 'Inbox/source.md', text, offset: 0, allowedRanges: [{ from: 0, to: text.length }], linkedNoteIds: new Set(), ignoredTerms: new Set(), allowed: () => true, ...extra };
}

describe('terms (§2)', () => {
  it('normalizes case and full-width characters without changing offsets', () => {
    for (const text of ['ＴＲＡＮＳformer　学习', 'İstanbul 👩‍💻 Straße']) expect(normalize(text)).toHaveLength(text.length);
    expect(normalize('ＡＩ　Transformer')).toBe('ai transformer');
  });
  it('derives keyphrases from titles and drops generic fragments', () => {
    expect(deriveTerms('Transformer 学习笔记')).toEqual(['Transformer']);
    expect(deriveTerms('2024-03-01 读书笔记：置身事内')).toContain('置身事内');
    expect(deriveTerms('2024-03-01 读书笔记：置身事内')).not.toContain('读书笔记');
    expect(deriveTerms('注意力机制（Attention）')).toEqual(expect.arrayContaining(['注意力机制', 'Attention']));
    expect(deriveTerms('《置身事内》')).toEqual(['置身事内']);
    expect(deriveTerms('周会 - 总结')).toEqual(['周会']);
  });
  it('adds English plurals only and keeps the strongest kind per term', () => {
    expect(inflections('Transformer')).toEqual(['Transformers']);
    expect(inflections('Index')).toEqual(['Indexs', 'Indexes']);
    expect(inflections('Strategy')).toEqual(['Strategys', 'Strategies']);
    expect(inflections('学习')).toEqual([]);
    const terms = termsFor('Transformer 学习笔记', ['Transformer']);
    expect(terms.get('transformer')).toBe('alias'); expect(terms.get('transformers')).toBe('inflection');
  });
  it('treats very short Latin and two-character CJK terms as short', () => {
    expect(isShortTerm('RNN')).toBe(true); expect(isShortTerm('学习')).toBe(true); expect(isShortTerm('注意力')).toBe(false); expect(isShortTerm('Transformer')).toBe(false);
  });
});

describe('matching (§3)', () => {
  it('uses Chinese word boundaries instead of raw substrings', () => {
    const index = new MemoryMetadataIndex();
    for (const [id, title] of [[1, '学习'], [2, '注意力机制'], [3, '深度学习']] as const) index.upsert(target(id, title));
    expect(texts(index, '我在研究深度学习。')).toEqual(['深度学习']);
    expect(texts(index, '注意力机制的作用很大')).toEqual(['注意力机制']);
    expect(texts(index, '我们一起学习吧')).toEqual(['学习']);
  });
  it('finds plurals, derived keyphrases and full-width text at original offsets', () => {
    const index = new MemoryMetadataIndex(); index.upsert(target(1, 'Transformer 学习笔记')); index.upsert(target(2, '注意力机制（Attention）'));
    const text = 'ＴＲＡＮＳＦＯＲＭＥＲＳ and attention';
    const matches = index.match(text, 5).matches;
    expect(matches.map(match => [match.text, match.kinds[match.noteIds[0]!]])).toEqual([['ＴＲＡＮＳＦＯＲＭＥＲＳ', 'derived'], ['attention', 'derived']]);
    for (const match of matches) expect(text.slice(match.from - 5, match.to - 5)).toBe(match.text);
  });
});

describe('link statistics (§4)', () => {
  it('counts anchors and adjacency per source and retracts them on update or removal', () => {
    const graph = new MemoryLinkGraph();
    graph.replaceSource(10, [{ targetId: 1, anchor: 'Transformer' }, { targetId: 1, anchor: 'transformer' }, { targetId: 2, anchor: 'Transformer' }]);
    expect([...graph.anchorCounts('TRANSFORMER')]).toEqual([[1, 2], [2, 1]]);
    graph.replaceSource(10, [{ targetId: 2, anchor: 'Transformer' }]);
    expect([...graph.anchorCounts('Transformer')]).toEqual([[2, 1]]);
    graph.removeNote(10); expect(graph.anchorCounts('Transformer').size).toBe(0);
  });
  it('scores co-citation and reciprocal links as relatedness', () => {
    const graph = new MemoryLinkGraph();
    graph.replaceSource(99, [{ targetId: 5, anchor: 'Attention' }, { targetId: 6, anchor: 'Seq2Seq' }]);
    graph.replaceSource(1, [{ targetId: 5, anchor: 'Attention' }, { targetId: 6, anchor: 'Seq2Seq' }]);
    graph.replaceSource(2, [{ targetId: 7, anchor: 'Voltage' }]);
    graph.replaceSource(3, [{ targetId: 99, anchor: 'source' }]);
    expect(graph.relatedness(99, 1)).toBeCloseTo(1); expect(graph.relatedness(99, 2)).toBe(0); expect(graph.relatedness(99, 3)).toBeCloseTo(.3);
  });
});

describe('tiers (§5)', () => {
  it('is confident for a unique, distinctive exact title and uncertain for derived or short terms', () => {
    const index = new MemoryMetadataIndex(); index.upsert(target(1, 'Transformer')); index.upsert(target(2, '注意力机制（Attention）')); index.upsert(target(3, 'RNN'));
    const matcher = new LocalMentionMatcher(index);
    expect(matcher.scan(request('Transformer 和 Attention 以及 RNN')).map(mention => [mention.text, mention.tier])).toEqual([['Transformer', 'confident'], ['Attention', 'uncertain'], ['RNN', 'uncertain']]);
  });
  it('promotes a short term that the user has linked before', () => {
    const index = new MemoryMetadataIndex(), graph = new MemoryLinkGraph(); index.upsert(target(3, 'RNN')); graph.replaceSource(50, [{ targetId: 3, anchor: 'RNN' }]);
    expect(new LocalMentionMatcher(index, graph).scan(request('RNN 很慢'))[0]?.tier).toBe('confident');
  });
  it('resolves ambiguity with link priors or graph context, otherwise leaves it to the model', () => {
    const index = new MemoryMetadataIndex(), graph = new MemoryLinkGraph();
    index.upsert(target(1, 'Transformer', { path: 'ML/Transformer.md' })); index.upsert(target(2, 'Transformer', { path: 'Power/Transformer.md' }));
    const matcher = new LocalMentionMatcher(index, graph);
    expect(matcher.scan(request('Transformer'))[0]?.tier).toBe('uncertain');
    graph.replaceSource(40, [{ targetId: 1, anchor: 'Transformer' }]); graph.replaceSource(41, [{ targetId: 1, anchor: 'Transformer' }]); graph.replaceSource(42, [{ targetId: 1, anchor: 'Transformer' }]);
    graph.replaceSource(43, [{ targetId: 1, anchor: 'Transformer' }]); graph.replaceSource(44, [{ targetId: 1, anchor: 'Transformer' }]); graph.replaceSource(45, [{ targetId: 1, anchor: 'Transformer' }]);
    const prior = matcher.scan(request('Transformer'))[0]!;
    expect(prior.tier).toBe('confident'); expect(prior.candidates[0]?.target.noteId).toBe(1);
    const context = new MemoryLinkGraph(); context.replaceSource(99, [{ targetId: 8, anchor: 'Attention' }]); context.replaceSource(2, [{ targetId: 8, anchor: 'Attention' }]);
    const related = new LocalMentionMatcher(index, context).scan(request('Transformer'))[0]!;
    expect(related.tier).toBe('confident'); expect(related.candidates[0]?.target.noteId).toBe(2);
  });
  it('drops ignored terms, overly shared derived terms, self links and linked targets', () => {
    const index = new MemoryMetadataIndex();
    for (let id = 1; id <= 4; id++) index.upsert(target(id, `周会 - ${id}月`));
    index.upsert(target(5, 'Transformer')); index.upsert(target(99, 'Source'));
    const matcher = new LocalMentionMatcher(index);
    expect(matcher.scan(request('周会 Transformer Source'))).toEqual([expect.objectContaining({ text: 'Transformer' })]);
    expect(matcher.scan(request('Transformer', { ignoredTerms: new Set(['transformer']) }))).toEqual([]);
    expect(matcher.scan(request('Transformer', { linkedNoteIds: new Set([5]) }))).toEqual([]);
  });
});

describe('sentences and explicit search (§6, §8)', () => {
  it('limits context to the surrounding sentence', () => {
    const text = 'Private first sentence. Transformer explains attention! Next one.';
    const range = sentenceRange(text, text.indexOf('Transformer'), text.indexOf('Transformer') + 11);
    expect(text.slice(range.from, range.to)).toBe(' Transformer explains attention!');
  });
  it('searches titles, aliases and derived terms and ranks linked anchors higher', () => {
    const index = new MemoryMetadataIndex(), graph = new MemoryLinkGraph();
    index.upsert(target(1, '注意力机制（Attention）')); index.upsert(target(2, '注意事项')); index.upsert(target(3, 'Unrelated'));
    graph.replaceSource(9, [{ targetId: 2, anchor: '注意' }]);
    const scorer = (query: string) => (text: string) => text.includes(query) ? -text.length : null;
    const result = searchTargets(index, graph, { scorer: scorer('注意'), query: '注意', sourceNoteId: 99, sourcePath: 'Inbox/a.md', allowed: () => true });
    expect(result.map(item => item.target.noteId)).toEqual([2, 1]);
    expect(searchTargets(index, graph, { scorer: scorer('attention'), query: 'attention', sourceNoteId: 99, sourcePath: 'Inbox/a.md', allowed: () => true }).map(item => item.target.noteId)).toEqual([1]);
  });
});

describe('Unicode and directory matching boundaries', () => {
  it('keeps emoji clusters whole and preserves original UTF-16 offsets', () => {
    const index = new MemoryMetadataIndex();
    index.upsert(target(1, '👍')); index.upsert(target(2, '🇯')); index.upsert(target(3, 'Transformer'));
    expect(index.match('👍🏽 🇯🇵').matches).toEqual([]);
    const text = '👍🏽 Ｔｒａｎｓｆｏｒｍｅｒ';
    const matches = index.match(text, 100).matches;
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ from: 105, to: 116, text: 'Ｔｒａｎｓｆｏｒｍｅｒ', noteIds: [3] });
    expect(text.slice(matches[0]!.from - 100, matches[0]!.to - 100)).toBe(matches[0]!.text);
  });
  it('uses equivalent word boundaries around halfwidth and fullwidth identifiers', () => {
    const index = new MemoryMetadataIndex(); index.upsert(target(1, 'Transformer'));
    for (const text of ['Transformer_model', 'Transformer＿model', 'model_Transformer', 'model＿Transformer', 'Ｔｒａｎｓｆｏｒｍｅｒ＿model']) {
      expect(index.match(text).matches, text).toEqual([]);
    }
    expect(texts(index, 'Transformer，model')).toEqual(['Transformer']);
  });
  it('matches the derived phrase after a complete compact calendar date', () => {
    for (const title of ['20240102_Transformer', '20240102 Transformer', '20240102-Transformer', '2024-01-02 Transformer', '2024年1月2日 Transformer']) {
      const index = new MemoryMetadataIndex(); index.upsert(target(1, title));
      expect(deriveTerms(title), title).toContain('Transformer');
      expect(index.match('Transformer').matches[0]?.kinds).toEqual({ 1: 'derived' });
    }
  });
  it('ranks root siblings above a folder resembling the source filename in both local flows', () => {
    const index = new MemoryMetadataIndex(), graph = new MemoryLinkGraph();
    index.upsert(target(1, 'Transformer', { path: 'Transformer.md' }));
    index.upsert(target(2, 'Transformer', { path: 'Source.m/Transformer.md' }));
    const candidates = new LocalMentionMatcher(index, graph).scan(request('Transformer', { sourcePath: 'Source.md' }))[0]!.candidates;
    expect(candidates.map(candidate => candidate.target.noteId)).toEqual([1, 2]);
    expect(candidates[0]!.score - candidates[1]!.score).toBeCloseTo(.1);
    const results = searchTargets(index, graph, { query: 'Transformer', scorer: () => 1, sourceNoteId: 99, sourcePath: 'Source.md', allowed: () => true });
    expect(results.map(item => item.target.noteId)).toEqual([1, 2]);
    expect(results[0]!.rank - results[1]!.rank).toBeCloseTo(.1);
  });
});
