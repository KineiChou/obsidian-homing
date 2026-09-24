// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { LinkQuerySuggest, linkAlias, parseLinkQuery } from '../src/ui/link-query-suggest';
import type { OrganizerController } from '../src/ui/types';
import type { TargetMatch } from '../src/linking/target-search';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { LinkTarget } from '../src/linking/types';
import { deferred, target } from './helpers';

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
    settings: () => DEFAULT_SETTINGS, searchLinkTargets: vi.fn(() => matches), verifyLinkQuery: vi.fn(async (_path: string, _match: string, _line: string, _candidates: readonly LinkTarget[], _current: () => boolean) => 2),
    linkMarkdown: vi.fn((target: LinkTarget, _source: string, alias?: string) => `[[${target.path.replace(/\.md$/, '')}${alias ? '|' + alias : ''}]]`),
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
  expect(f.controller.verifyLinkQuery).toHaveBeenCalledExactlyOnceWith('Inbox/a.md', 'transformer', 'We use transformer here', expect.any(Array), expect.any(Function));
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

it('cancels the request when the query is closed before debounce', async () => {
  vi.useFakeTimers(); const f = fixture();
  f.suggest.getSuggestions(f.context as never);
  f.suggest.close();
  await vi.advanceTimersByTimeAsync(601);
  expect(f.controller.verifyLinkQuery).not.toHaveBeenCalled();
});
it('checks the same term again when it appears in a different sentence', async () => {
  vi.useFakeTimers(); const f = fixture();
  f.suggest.getSuggestions(f.context as never);
  await vi.advanceTimersByTimeAsync(601);
  f.suggest.close();
  const line = 'Attention models use [[?transformer]]';
  const editor = { getLine: () => line, replaceRange: vi.fn() };
  const trigger = f.suggest.onTrigger({ line: 0, ch: line.indexOf(']]') }, editor as never, { path: 'Inbox/a.md' } as never)!;
  const context = { ...trigger, editor, file: { path: 'Inbox/a.md' } };
  f.suggest.context = context as never;
  expect(f.suggest.getSuggestions(context as never).every(item => !item.recommended)).toBe(true);
  await vi.advanceTimersByTimeAsync(601);
  expect(f.controller.verifyLinkQuery).toHaveBeenCalledTimes(2);
});
it('does not replace text that changed after the choices were shown', () => {
  const f = fixture(); const [item] = f.suggest.getSuggestions(f.context as never);
  f.editor.getLine = () => 'Unrelated replacement content in this editor';
  f.suggest.selectSuggestion(item!);
  expect(f.editor.replaceRange).not.toHaveBeenCalled();
});
it('cancels a pending request when the query becomes empty', async () => {
  vi.useFakeTimers(); const f = fixture();
  f.suggest.getSuggestions(f.context as never);
  f.suggest.getSuggestions({ ...f.context, query: '' } as never);
  await vi.advanceTimersByTimeAsync(601);
  expect(f.controller.verifyLinkQuery).not.toHaveBeenCalled();
});

it('rejects an old A result after the query changes A → B → A', async () => {
  vi.useFakeTimers(); const f = fixture();
  const first = deferred<number>(), second = deferred<number>(), latest = deferred<number>();
  f.controller.verifyLinkQuery.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise).mockImplementationOnce(() => latest.promise);
  const lineA = f.editor.getLine();
  const activate = (line: string) => {
    f.editor.getLine = () => line;
    const trigger = f.suggest.onTrigger({ line: 0, ch: line.indexOf(']]') }, f.editor as never, f.context.file as never)!;
    const context = { ...trigger, editor: f.editor, file: f.context.file };
    f.suggest.context = context as never; f.suggest.getSuggestions(context as never); return context;
  };
  activate(lineA); await vi.advanceTimersByTimeAsync(601);
  activate('Audio [[?attention]] works'); await vi.advanceTimersByTimeAsync(601);
  const active = activate(lineA); await vi.advanceTimersByTimeAsync(601);
  first.resolve(2); second.resolve(2); await Promise.resolve(); await Promise.resolve();
  expect(f.suggest.getSuggestions(active as never).every(item => !item.recommended)).toBe(true);
  expect(f.controller.verifyLinkQuery.mock.calls[0]![4]()).toBe(false);
  latest.resolve(1); await Promise.resolve(); await Promise.resolve();
  expect(f.suggest.getSuggestions(active as never)[0]).toMatchObject({ recommended: true, match: { target: { noteId: 1 } } });
  f.suggest.close();
});
