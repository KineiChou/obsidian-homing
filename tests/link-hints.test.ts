// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { OrganizerError } from '../src/core/errors';
import { Emitter } from '../src/core/events';
import { DEFAULT_SETTINGS, type LinkHintStyle } from '../src/settings';
import { setLocale } from '../src/i18n';
import { linkHints, QUIET_MS } from '../src/ui/link-hints';
import type { LinkPlan, LinkProposal, LinkTarget, TextRange } from '../src/linking/types';
import type { LinkMention, OrganizerController } from '../src/ui/types';
import { context, deferred, target } from './helpers';

const cleanup: (() => void)[] = [];
beforeEach(() => { setLocale('en'); vi.useFakeTimers(); });
afterEach(() => { for (const close of cleanup.splice(0)) close(); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); });
const TEXT = 'We encode audio with Transformer models and Attention.';

function fixture(style: LinkHintStyle = 'underline', parent: HTMLElement = document.body, verifyOnHover = true) {
  const changes = new Emitter();
  const mention = (text: string, tier: LinkMention['tier'], ids: number[]): LinkMention => {
    const from = TEXT.indexOf(text);
    return { verdictKey: text, from, to: from + text.length, text, tier, candidates: ids.map((id, index) => ({ target: target(id, index ? `${text} (other)` : text), kind: 'title' as const, score: 1 - index / 10, commonness: .5, related: 0 })) };
  };
  let mentions = [mention('Transformer', 'confident', [1, 11]), mention('Attention', 'uncertain', [2, 12])];
  const verdicts = new Map<string, number | null>(), pending = new Map<string, ReturnType<typeof deferred<number | null>>>();
  const settings = { ...DEFAULT_SETTINGS, linkHints: style, verifyOnHover };
  const controller = {
    subscribe: (listener: () => void) => changes.subscribe(listener), settings: () => settings,
    scanLinks: vi.fn((_session: string, ranges: readonly TextRange[]) => mentions.filter(item => ranges.some(range => range.from <= item.from && range.to >= item.to) && verdicts.get(item.verdictKey) !== null)
      .map(item => verdicts.has(item.verdictKey) ? { ...item, verified: verdicts.get(item.verdictKey)! } : item)),
    verifyLink: vi.fn((_session: string, item: LinkMention) => { const wait = deferred<number | null>(); pending.set(item.text, wait); return wait.promise.then(selected => { verdicts.set(item.verdictKey, selected); changes.emit(); return selected; }); }),
    linkProposalFor: vi.fn((_session: string, item: LinkMention, noteId?: number): LinkProposal => { if (!mentions.some(current => current.verdictKey === item.verdictKey)) throw new OrganizerError('stale', 'error.linkStale'); return ({ id: item.text, context, selected: noteId ?? item.candidates[0]!.target.noteId, input: { catalogueEpoch: 1, candidates: item.candidates.map(candidate => candidate.target), anchor: { editorSessionId: 'session', noteId: 99, sourcePath: 'Note.md', documentRevision: 1, from: item.from, to: item.to, originalText: item.text, contextFrom: 0, contextText: TEXT } } }); }),
    prepareLink: vi.fn((item: LinkProposal, noteId: number): LinkPlan => ({ id: 'plan-' + item.id, proposalId: item.id, anchor: item.input.anchor, target: item.input.candidates.find(candidate => candidate.noteId === noteId)!, replacement: '[[x]]', catalogueEpoch: 1, settingsRevision: 1 })),
    confirmLinks: vi.fn((plans: readonly LinkPlan[]) => { mentions = mentions.filter(item => !plans.some(plan => plan.proposalId === item.text)); changes.emit(); return { appliedPlanIds: plans.map(plan => plan.id), failures: [] }; }),
    dismissLink: vi.fn((item: LinkProposal) => { mentions = mentions.filter(value => value.text !== item.id); changes.emit(); }),
    ignoreLinkTerm: vi.fn(async () => undefined),
  };
  const host = { sessionId: () => 'session', chooseTarget: vi.fn<(candidates: readonly LinkTarget[], choose: (noteId: number) => void) => void>() };
  const hints = linkHints(controller as unknown as OrganizerController, host);
  const view = new EditorView({ parent, state: EditorState.create({ doc: TEXT, extensions: [hints.extension] }) });
  cleanup.push(() => view.destroy());
  const hint = (text: string) => [...view.contentDOM.querySelectorAll<HTMLElement>('.note-organizer-link-hint')].find(item => item.textContent === text)!;
  return { changeContext: () => { mentions = mentions.map(item => ({ ...item, verdictKey: item.verdictKey + ':changed' })); changes.emit(); }, invalidate: () => { mentions = []; changes.emit(); }, pending, view, hints, controller, host, hint,
    marks: () => [...view.contentDOM.querySelectorAll('.note-organizer-link-hint')].map(item => [item.textContent, item.classList.contains('is-confident') ? 'confident' : 'uncertain']),
    card: () => parent.ownerDocument.body.querySelector<HTMLElement>('.note-organizer-hint-card'),
    button: (text: string) => [...parent.ownerDocument.body.querySelector('.note-organizer-hint-card')!.querySelectorAll('button')].find(item => item.textContent === text)! };
}
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const hover = async (element: Element) => { element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await vi.advanceTimersByTimeAsync(301); };

it('shows clear and ambiguous mentions differently without changing the text, live except under the caret', async () => {
  const f = fixture(); expect(f.marks()).toEqual([['Transformer', 'confident'], ['Attention', 'uncertain']]);
  expect(f.view.state.doc.toString()).toBe(TEXT);
  f.view.dispatch({ changes: { from: TEXT.length, insert: ' More' } }); expect(f.marks()).toHaveLength(2);
  const end = TEXT.indexOf('Attention') + 'Attention'.length;
  f.view.dispatch({ changes: { from: f.view.state.doc.length, insert: '!' }, selection: EditorSelection.cursor(end) });
  expect(f.marks().map(mark => mark[0])).toEqual(['Transformer']);
  await vi.advanceTimersByTimeAsync(QUIET_MS + 20); await flush();
  expect(f.marks().map(mark => mark[0])).toEqual(['Transformer', 'Attention']); expect(f.controller.verifyLink).not.toHaveBeenCalled();
});

it('offers a line marker or nothing according to the display setting', () => {
  const marker = fixture('marker'); expect(marker.marks()).toEqual([]);
  expect(marker.view.contentDOM.querySelectorAll('.note-organizer-link-marker')).toHaveLength(1);
  expect(marker.view.contentDOM.querySelector('.note-organizer-link-marker')?.getAttribute('aria-label')).toBe('2 link suggestions on this line');
  const off = fixture('off'); expect(off.marks()).toEqual([]); expect(off.controller.scanLinks).not.toHaveBeenCalled();
});

it('links a clear mention without asking the model, after an optional target change', async () => {
  const f = fixture(); await hover(f.hint('Transformer'));
  expect(f.card()?.textContent).toContain('Resources › Transformer'); expect(f.controller.verifyLink).not.toHaveBeenCalled();
  f.button('Other note…').click(); f.host.chooseTarget.mock.calls[0]![1](11);
  expect(f.card()?.textContent).toContain('Transformer (other)'); expect(f.controller.confirmLinks).not.toHaveBeenCalled();
  f.button('Link').click();
  expect(f.controller.prepareLink).toHaveBeenCalledWith(expect.objectContaining({ id: 'Transformer' }), 11);
  await flush(); expect(f.card()).toBeNull(); expect(f.marks().map(mark => mark[0])).toEqual(['Attention']);
});

it('asks the model once on hover for an ambiguous mention and shows its choice', async () => {
  const f = fixture(); await hover(f.hint('Attention'));
  expect(f.controller.verifyLink).toHaveBeenCalledOnce(); expect(f.card()?.textContent).toContain('Checking which note');
  f.pending.get('Attention')!.resolve(2); await flush();
  expect(f.card()?.textContent).toContain('Resources › Attention'); expect(f.marks()).toEqual([['Transformer', 'confident'], ['Attention', 'confident']]);
  f.button('Link').click(); expect(f.controller.prepareLink).toHaveBeenCalledWith(expect.objectContaining({ id: 'Attention' }), 2);
  expect(f.controller.verifyLink).toHaveBeenCalledOnce();
});

it('keeps the answer visible when the model says no link, and still allows a manual choice', async () => {
  const f = fixture(); await hover(f.hint('Attention'));
  f.pending.get('Attention')!.resolve(null); await flush();
  expect(f.marks().map(mark => mark[0])).toEqual(['Transformer']);
  expect(f.card()?.textContent).toContain('may not need a link');
  f.button('Resources › Attention (other)').click(); f.button('Link').click();
  expect(f.controller.prepareLink).toHaveBeenCalledWith(expect.objectContaining({ id: 'Attention' }), 12);
});

it('does not ask the model when on-request checks are off; ignoring and never-suggest are available', async () => {
  const f = fixture('underline', document.body, false); await hover(f.hint('Attention'));
  expect(f.controller.verifyLink).not.toHaveBeenCalled(); expect(f.card()?.textContent).toContain('Choose the note');
  f.button('Never suggest “Attention”').click(); expect(f.controller.ignoreLinkTerm).toHaveBeenCalledWith('Attention');
  await hover(f.hint('Transformer')); f.button('Ignore').click(); await flush();
  expect(f.controller.dismissLink).toHaveBeenCalledOnce(); expect(f.card()).toBeNull();
});

it('accepts a clear mention at the cursor through the command and opens the card for an ambiguous one', () => {
  const f = fixture(); vi.spyOn(f.view, 'hasFocus', 'get').mockReturnValue(true); vi.spyOn(f.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 20, top: 10, bottom: 20 });
  f.view.dispatch({ selection: EditorSelection.cursor(1) }); expect(f.hints.acceptAtCursor(true)).toBe(false);
  f.view.dispatch({ selection: EditorSelection.cursor(TEXT.indexOf('Transformer') + 2) });
  expect(f.hints.acceptAtCursor(true)).toBe(true); expect(f.controller.confirmLinks).not.toHaveBeenCalled();
  f.hints.acceptAtCursor(); expect(f.controller.confirmLinks).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ proposalId: 'Transformer' })]);
  f.view.dispatch({ selection: EditorSelection.cursor(TEXT.indexOf('Attention') + 2) });
  f.hints.acceptAtCursor(); expect(f.controller.confirmLinks).toHaveBeenCalledOnce(); expect(f.controller.verifyLink).toHaveBeenCalledOnce(); expect(f.card()).not.toBeNull();
});

it('popout hover uses the popout DOM realm', async () => {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const doc = frame.contentDocument!; const win = frame.contentWindow!;
  const f = fixture('marker', doc.body);
  const mark = f.view.contentDOM.querySelector('.note-organizer-link-marker')!;
  expect(mark instanceof Element).toBe(false);
  mark.dispatchEvent(new (win as unknown as typeof window).MouseEvent('mouseover', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(301);
  expect(f.card()).not.toBeNull();
});

it('hover invalidated before timer runs does not throw', async () => {
  const f = fixture();
  f.hint('Transformer').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  f.invalidate(); await flush();
  expect(f.marks()).toEqual([]);
  await vi.advanceTimersByTimeAsync(301);
  expect(f.card()).toBeNull();
});

it('focus moving from editor to card preserves focused action', async () => {
  const f = fixture(); vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  f.view.focus(); await vi.advanceTimersByTimeAsync(11);
  await hover(f.hint('Transformer'));
  const action = f.card()!.querySelector<HTMLButtonElement>('button')!;
  action.focus(); expect(document.activeElement).toBe(action);
  await vi.advanceTimersByTimeAsync(11);
  expect(action.isConnected).toBe(true);
  expect(document.activeElement).toBe(action);
});

it('delayed cursor card does not open after focus leaves pane', async () => {
  const f = fixture(); vi.spyOn(f.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 20, top: 10, bottom: 20 }); const focus = vi.spyOn(f.view, 'hasFocus', 'get').mockReturnValue(true);
  f.view.dispatch({ selection: EditorSelection.cursor(TEXT.indexOf('Attention') + 2) });
  focus.mockReturnValue(false); f.view.update([]);
  await vi.advanceTimersByTimeAsync(701);
  expect(f.card()).toBeNull();
});

it('does not reuse a hover verdict after the sentence changes at the same offsets', async () => {
  const f = fixture(); await hover(f.hint('Attention'));
  f.pending.get('Attention')!.resolve(2); await flush();
  f.view.dispatch({ changes: { from: TEXT.length, insert: ' Different meaning.' } });
  f.changeContext(); await flush(); await hover(f.hint('Attention'));
  expect(f.controller.verifyLink).toHaveBeenCalledTimes(2);
  expect(f.card()?.textContent).toContain('Checking which note');
  f.pending.get('Attention')!.resolve(12); await flush();
  f.button('Link').click();
  expect(f.controller.prepareLink).toHaveBeenCalledWith(expect.objectContaining({ id: 'Attention' }), 12);
});

it('retries a failed check when the user reopens the card', async () => {
  const f = fixture(); await hover(f.hint('Attention'));
  f.pending.get('Attention')!.reject(new Error('temporary failure')); await flush();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await hover(f.hint('Attention'));
  expect(f.controller.verifyLink).toHaveBeenCalledTimes(2);
  f.pending.get('Attention')!.resolve(2); await flush();
  expect(f.card()?.textContent).toContain('Resources › Attention');
});

it('ignores an old pending verdict after a new sentence reuses the mention offsets', async () => {
  const f = fixture(); await hover(f.hint('Attention'));
  const previous = f.pending.get('Attention')!;
  f.view.dispatch({ changes: { from: TEXT.length, insert: ' Different meaning.' } });
  f.changeContext(); await flush(); await hover(f.hint('Attention'));
  previous.resolve(2); await flush();
  expect(f.card()?.textContent).toContain('Checking which note');
  f.pending.get('Attention')!.resolve(12); await flush();
  expect(f.card()?.textContent).toContain('Resources › Attention (other)');
});
