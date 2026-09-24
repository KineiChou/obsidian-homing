// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Emitter } from '../src/core/events';
import { DEFAULT_SETTINGS, type LinkHintStyle } from '../src/settings';
import { setLocale } from '../src/i18n';
import { linkHints, QUIET_MS } from '../src/ui/link-hints';
import type { LinkPlan, LinkProposal } from '../src/linking/types';
import type { OrganizerController } from '../src/ui/types';
import { context, target } from './helpers';

const cleanup: (() => void)[] = [];
beforeEach(() => { setLocale('en'); vi.useFakeTimers(); });
afterEach(() => { for (const close of cleanup.splice(0)) close(); document.body.replaceChildren(); vi.useRealTimers(); });
const TEXT = 'We encode audio with Transformer models and Attention.';

function fixture(style: LinkHintStyle = 'underline') {
  const changes = new Emitter();
  const proposal = (text: string, noteId: number): LinkProposal => {
    const from = TEXT.indexOf(text);
    return { id: text, context, selected: noteId, input: { catalogueEpoch: 1, candidates: [target(noteId, text), target(noteId + 10, text + ' (other)')], anchor: { editorSessionId: 'session', noteId: 99, sourcePath: 'Note.md', documentRevision: 1, from, to: from + text.length, originalText: text, contextFrom: 0, contextText: TEXT } } };
  };
  let links = [proposal('Transformer', 1), proposal('Attention', 2)];
  const settings = { ...DEFAULT_SETTINGS, linkHints: style };
  const controller = {
    subscribe: (listener: () => void) => changes.subscribe(listener), settings: () => settings, linkSuggestions: () => links,
    prepareLink: vi.fn((item: LinkProposal, noteId: number): LinkPlan => ({ id: 'plan-' + item.id, proposalId: item.id, anchor: item.input.anchor, target: item.input.candidates.find(candidate => candidate.noteId === noteId)!, replacement: '[[x]]', catalogueEpoch: 1, settingsRevision: 1 })),
    confirmLinks: vi.fn((plans: readonly LinkPlan[]) => { links = links.filter(item => !plans.some(plan => plan.proposalId === item.id)); changes.emit(); return { appliedPlanIds: plans.map(plan => plan.id), failures: [] }; }),
    dismissLink: vi.fn((item: LinkProposal) => { links = links.filter(value => value.id !== item.id); changes.emit(); }),
  };
  const host = { sessionId: () => 'session', chooseTarget: vi.fn<(proposal: LinkProposal, choose: (noteId: number) => void) => void>() };
  const hints = linkHints(controller as unknown as OrganizerController, host);
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: TEXT, extensions: [hints.extension] }) });
  cleanup.push(() => view.destroy());
  return { view, hints, controller, host, marks: () => [...view.contentDOM.querySelectorAll('.note-organizer-link-hint')].map(item => item.textContent), card: () => document.body.querySelector<HTMLElement>('.note-organizer-hint-card') };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

it('underlines mentions without changing text, hides them while typing and restores them after a pause', async () => {
  const f = fixture(); expect(f.marks()).toEqual(['Transformer', 'Attention']);
  expect(f.view.state.doc.toString()).toBe(TEXT);
  f.view.dispatch({ changes: { from: TEXT.length, insert: ' More' } }); expect(f.marks()).toEqual([]);
  await vi.advanceTimersByTimeAsync(QUIET_MS - 100); expect(f.marks()).toEqual([]);
  await vi.advanceTimersByTimeAsync(200); await flush(); expect(f.marks()).toEqual(['Transformer', 'Attention']);
});

it('offers a line marker or nothing according to the display setting', () => {
  const marker = fixture('marker'); expect(marker.marks()).toEqual([]);
  expect(marker.view.contentDOM.querySelectorAll('.note-organizer-link-marker')).toHaveLength(1);
  expect(marker.view.contentDOM.querySelector('.note-organizer-link-marker')?.getAttribute('aria-label')).toBe('2 link suggestions on this line');
  const off = fixture('off'); expect(off.marks()).toEqual([]); expect(off.view.contentDOM.querySelector('.note-organizer-link-marker')).toBeNull();
});

it('opens a hover card that links, changes the target, or ignores one suggestion', async () => {
  const f = fixture(); const mark = f.view.contentDOM.querySelector('.note-organizer-link-hint')!;
  mark.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); expect(f.card()).toBeNull();
  await vi.advanceTimersByTimeAsync(301); expect(f.card()?.textContent).toContain('Resources › Transformer');
  [...f.card()!.querySelectorAll('button')].find(item => item.textContent === 'Other note…')!.click();
  f.host.chooseTarget.mock.calls[0]![1](11); expect(f.card()?.textContent).toContain('Transformer (other)');
  expect(f.controller.confirmLinks).not.toHaveBeenCalled();
  [...f.card()!.querySelectorAll('button')].find(item => item.textContent === 'Link')!.click();
  expect(f.controller.prepareLink).toHaveBeenCalledWith(expect.objectContaining({ id: 'Transformer' }), 11);
  await flush(); expect(f.card()).toBeNull(); expect(f.marks()).toEqual(['Attention']);
  const second = f.view.contentDOM.querySelector('.note-organizer-link-hint')!;
  second.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await vi.advanceTimersByTimeAsync(301);
  [...f.card()!.querySelectorAll('button')].find(item => item.textContent === 'Ignore')!.click(); await flush();
  expect(f.controller.dismissLink).toHaveBeenCalledOnce(); expect(f.marks()).toEqual([]);
});

it('accepts the suggestion under the cursor only through the explicit command', () => {
  const f = fixture(); vi.spyOn(f.view, 'hasFocus', 'get').mockReturnValue(true);
  f.view.dispatch({ selection: EditorSelection.cursor(1) });
  expect(f.hints.acceptAtCursor(true)).toBe(false);
  f.view.dispatch({ selection: EditorSelection.cursor(TEXT.indexOf('Attention') + 2) });
  expect(f.hints.acceptAtCursor(true)).toBe(true); expect(f.controller.confirmLinks).not.toHaveBeenCalled();
  expect(f.hints.acceptAtCursor()).toBe(true);
  expect(f.controller.confirmLinks).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ proposalId: 'Attention' })]);
});
