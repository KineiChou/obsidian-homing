// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { LinkQuerySuggest, linkAlias, parseLinkQuery } from '../src/ui/link-query-suggest';
import type { OrganizerController } from '../src/ui/types';
import type { TargetMatch } from '../src/linking/target-search';
import { DEFAULT_SETTINGS } from '../src/settings';
import { target } from './helpers';

afterEach(() => vi.useRealTimers());
it('parses [[?match|display on the current line and swallows an auto-closed ]]', () => {
  expect(parseLinkQuery('see [[?注意力|自注意力', 18)).toEqual({ start: 4, end: 18, match: '注意力', display: '自注意力' });
  expect(parseLinkQuery('see [[?transformer]] more', 18)).toEqual({ start: 4, end: 20, match: 'transformer', display: '' });
  expect(parseLinkQuery('see [[?a｜b', 10)).toMatchObject({ match: 'a', display: 'b' });
  expect(parseLinkQuery('see [[plain', 11)).toBeNull();
  expect(parseLinkQuery('[[?done]] then text', 19)).toBeNull();
});
it('uses the display text as alias, else the typed match when it differs from the title', () => {
  expect(linkAlias('注意力', '自注意力', '注意力机制')).toBe('自注意力');
  expect(linkAlias('attention', '', '注意力机制（Attention）')).toBe('attention');
  expect(linkAlias('transformer', '', 'Transformer')).toBeUndefined();
});

function fixture() {
  const matches: TargetMatch[] = [{ target: target(1, 'Transformer'), kind: 'title', matched: 'transformer', rank: 1 }, { target: target(2, 'Transformer', { path: 'Power/Transformer.md' }), kind: 'title', matched: 'transformer', rank: .9 }];
  const controller = {
    settings: () => DEFAULT_SETTINGS, searchLinkTargets: vi.fn(() => matches), verifyLinkQuery: vi.fn(async () => 2),
    linkMarkdown: vi.fn((path: string, _source: string, alias?: string) => `[[${path.replace(/\.md$/, '')}${alias ? '|' + alias : ''}]]`),
  };
  const line = 'We use [[?transformer|变压器]] here';
  const editor = { getLine: () => line, replaceRange: vi.fn() };
  const suggest = new LinkQuerySuggest({} as App, controller as unknown as OrganizerController);
  const trigger = suggest.onTrigger({ line: 0, ch: line.indexOf(']]') }, editor as never, { path: 'Inbox/a.md' } as never)!;
  const context = { ...trigger, editor, file: { path: 'Inbox/a.md' } };
  suggest.context = context as never;
  return { suggest, controller, editor, context, trigger };
}
it('lists local matches at once and adds one model recommendation after typing pauses', async () => {
  vi.useFakeTimers(); const f = fixture();
  expect(f.trigger).toMatchObject({ start: { line: 0, ch: 7 }, end: { line: 0, ch: 27 }, query: 'transformer|变压器' });
  expect(f.suggest.getSuggestions(f.context as never).map(item => item.match.target.noteId)).toEqual([1, 2]);
  expect(f.controller.verifyLinkQuery).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(601);
  expect(f.controller.verifyLinkQuery).toHaveBeenCalledExactlyOnceWith('Inbox/a.md', 'transformer', 'We use transformer here', expect.any(Array));
  const ranked = f.suggest.getSuggestions(f.context as never);
  expect(ranked.map(item => [item.match.target.noteId, item.recommended])).toEqual([[2, true], [1, false]]);
  expect(f.controller.verifyLinkQuery).toHaveBeenCalledOnce();
});
it('inserts a standard link only when a row is chosen', () => {
  const f = fixture(); const [first] = f.suggest.getSuggestions(f.context as never);
  expect(f.editor.replaceRange).not.toHaveBeenCalled();
  f.suggest.selectSuggestion(first!);
  expect(f.editor.replaceRange).toHaveBeenCalledExactlyOnceWith('[[Resources/Transformer|变压器]]', { line: 0, ch: 7 }, { line: 0, ch: 27 });
});
