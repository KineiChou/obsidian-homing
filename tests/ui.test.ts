// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewPanel } from '../src/ui/review-panel';
import type { OrganizerController, ReviewState } from '../src/ui/types';
import { DEFAULT_SETTINGS } from '../src/settings';
import { context, deferred, note } from './helpers';
import type { FilingEntry, MovePlan, MoveRecord } from '../src/filing/types';
import { setLocale } from '../src/i18n';

const disposals: (() => void)[] = [];
beforeEach(() => setLocale('en'));
afterEach(() => { disposals.splice(0).forEach(close => close()); document.body.replaceChildren(); vi.useRealTimers(); });
function fixture() {
  let listener = () => undefined as void;
  const entries: FilingEntry[] = [{ path: note.source.path, status: 'ready', updatedAt: 1, message: null, proposal: { id: 'p', source: note.source, foldersRevision: 1, context, selected: 'f1', ranked: [{ targetId: 'f1', probability: .55 }, { targetId: 'f2', probability: .45 }] } }];
  const state: ReviewState = { filing: entries, links: [], activePath: note.source.path, network: { pending: 0, inFlight: false, paused: false, reason: null }, indexReady: true, message: null };
  const plan: MovePlan = { id: 'move', source: note.source, destination: 'Resources/笔记.md', folderId: 'f1', foldersRevision: 1, settingsRevision: 0 };
  const records: MoveRecord[] = [];
  const controller = {
    state: () => state, subscribe: (callback: () => void) => { listener = callback; return () => { listener = () => undefined; }; }, settings: () => ({ ...DEFAULT_SETTINGS, inbox: 'Inbox', secretName: 'key' }),
    folders: () => [{ id: 'f1', path: 'Resources', directPurpose: '', effectiveRules: [] }, { id: 'f2', path: 'Projects', directPurpose: '', effectiveRules: [] }], recentMoves: () => records,
    readPreview: vi.fn(async () => ({ text: '# Note body', truncated: false })),
    prepareMove: vi.fn(async (path: string, id: string) => ({ ...plan, id: path, source: { ...note.source, path }, folderId: id, destination: `${id === 'f1' ? 'Resources' : 'Projects'}/${path.split('/').at(-1)}` })),
    confirmMove: vi.fn(async (move: MovePlan) => { const index = entries.findIndex(entry => entry.path === move.source.path); entries[index] = { ...entries[index]!, status: 'done', moveRecordId: move.id }; records.push({ id: move.id, noteId: 1, from: move.source.path, to: move.destination, contentHash: '', createdAt: 1, status: 'done' }); listener(); }),
    undoMove: vi.fn(async () => undefined), openNote: vi.fn(), analyzeInbox: vi.fn(), analyzeNote: vi.fn(), ignoreNote: vi.fn(), acknowledgeMove: vi.fn(),
  } as unknown as OrganizerController;
  const container = document.body.appendChild(document.createElement('div')); let choose: (id: string) => void = () => undefined;
  const actions = { settings: vi.fn(), folder: (callback: (id: string) => void) => { choose = callback; }, analyze: vi.fn(), preview: vi.fn(async (text: string, element: HTMLElement) => { element.textContent = text; }), menu: vi.fn() };
  const panel = new ReviewPanel(container, controller, actions); disposals.push(() => panel.destroy());
  return { container, controller, panel, state, entries, actions, emit: () => listener(), choose: (id: string) => choose(id), plan, records };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function control(container: HTMLElement, text: string) { const button = [...container.querySelectorAll('button')].find(button => button.textContent === text); if (!button) throw Error('Missing button ' + text); return button; }
describe('inbox organizer interaction', () => {
  it('previews Markdown, shows uncertain alternatives, and moves only the displayed plan', async () => {
    const f = fixture(); await tick(); expect(f.container.textContent).toContain('Note body'); expect(f.container.textContent).toContain('Also consider');
    expect(f.controller.confirmMove).not.toHaveBeenCalled(); control(f.container, 'Projects').click(); await tick(); control(f.container, 'Move to Projects').click(); await tick();
    expect(f.controller.confirmMove).toHaveBeenCalledWith(expect.objectContaining({ folderId: 'f2' })); expect(f.container.querySelector('.note-organizer-undo')?.textContent).toContain('Undo');
  });
  it('advances after filing and blocks double clicks and repeated Enter from filing the next note', async () => {
    vi.useFakeTimers(); const f = fixture(); f.entries.push({ ...f.entries[0]!, path: 'Inbox/next.md', proposal: { ...f.entries[0]!.proposal!, source: { ...note.source, path: 'Inbox/next.md' }, id: 'next' } }); f.emit(); await tick();
    control(f.container, 'Move to Resources').click(); await tick();
    expect(f.container.querySelector('.note-organizer-detail-head')?.textContent).toContain('next'); control(f.container, 'Move to Resources').click();
    f.container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true })); expect(f.controller.confirmMove).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(401); control(f.container, 'Move to Resources').click(); await tick(); expect(f.controller.confirmMove).toHaveBeenCalledTimes(2);
  });
  it('keeps a manual location and external focus across background updates and late preparations', async () => {
    const f = fixture(); await tick(); const older = deferred<MovePlan>(), newer = deferred<MovePlan>();
    vi.mocked(f.controller.prepareMove).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise); control(f.container, 'Other location…').click(); f.choose('f1'); f.choose('f2');
    newer.resolve({ ...f.plan, id: 'newer', folderId: 'f2', destination: 'Projects/笔记.md' }); await tick(); older.resolve(f.plan); await tick();
    const editor = document.body.appendChild(document.createElement('textarea')); editor.focus(); f.emit(); await tick(); expect(document.activeElement).toBe(editor);
    control(f.container, 'Move to Projects').click(); expect(f.controller.confirmMove).toHaveBeenCalledWith(expect.objectContaining({ id: 'newer' }));
  });
  it('keeps a pending preview from replacing a newer selected note and cleans rendered resources', async () => {
    const f = fixture(); await tick(); const pending = deferred<{ text: string; truncated: boolean }>(); vi.mocked(f.controller.readPreview).mockReturnValueOnce(pending.promise);
    f.entries.push({ path: 'Inbox/second.md', status: 'waiting', updatedAt: 1, message: null }); f.emit();
    const second = f.container.querySelectorAll<HTMLButtonElement>('.note-organizer-row > button')[1]!; second.click();
    f.container.querySelector<HTMLButtonElement>('.note-organizer-row > button')!.click(); await tick(); pending.resolve({ text: 'Stale preview', truncated: false }); await tick();
    expect(f.container.querySelector('.note-organizer-preview')?.textContent).toBe('# Note body');
  });
  it('offers selection-based analysis, keeps waiting notes collapsed and does not bind global shortcuts', async () => {
    const f = fixture(); await tick(); f.entries.push({ path: 'Inbox/unclear.md', status: 'unassigned', updatedAt: 1, message: null }); f.emit();
    const waiting = [...f.container.querySelectorAll('details')].find(element => element.querySelector('summary')?.textContent === 'Undecided'); expect(waiting?.open).toBe(false);
    const check = f.container.querySelector<HTMLInputElement>('.note-organizer-row input')!; check.click(); control(f.container, 'Analyze selected…').click(); expect(f.actions.analyze).toHaveBeenCalledWith([note.source.path]);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); expect(f.controller.confirmMove).not.toHaveBeenCalled();
  });
  it('applies a picker choice to the current controls after folder creation refreshes the catalog', async () => {
    const f = fixture(); await tick(); control(f.container, 'Other location…').click();
    f.entries[0] = { ...f.entries[0]!, proposal: { ...f.entries[0]!.proposal!, foldersRevision: 2 } }; f.emit(); await tick();
    f.choose('f2'); await tick(); const accept = control(f.container, 'Move to Projects'); expect(accept.isConnected).toBe(true); expect(accept.disabled).toBe(false);
    accept.click(); expect(f.controller.confirmMove).toHaveBeenCalledWith(expect.objectContaining({ folderId: 'f2' }));
  });
  it('clears the previous manual destination when a rename removes the active queue entry', async () => {
    const f = fixture(); f.entries.push({ ...f.entries[0]!, path: 'Inbox/next.md', proposal: { ...f.entries[0]!.proposal!, id: 'next' } }); f.emit(); await tick();
    control(f.container, 'Other location…').click(); f.choose('f2'); await tick();
    vi.mocked(f.controller.confirmMove).mockImplementationOnce(async () => { f.entries.splice(0, 1); f.emit(); });
    control(f.container, 'Move to Projects').click(); await tick();
    expect(f.container.querySelector('.note-organizer-detail-head')?.textContent).toContain('next'); expect(control(f.container, 'Move to Resources').disabled).toBe(true);
  });
  it('keeps group labels accurate after undo and background completion without changing the selected note', async () => {
    const f = fixture(); await tick(); f.entries.push({ path: 'Inbox/queued.md', status: 'waiting', updatedAt: 1, message: null }); f.emit();
    f.entries[1] = { ...f.entries[1]!, status: 'ready', proposal: { ...f.entries[0]!.proposal!, id: 'queued' } }; f.emit();
    const row = [...f.container.querySelectorAll('.note-organizer-row')].find(row => row.textContent?.includes('queued'))!;
    expect(row.parentElement?.querySelector('h3')?.textContent).toBe('Suggested'); expect(f.container.querySelector('.note-organizer-detail-head')?.textContent).not.toContain('queued');
  });
  it('preserves failed action feedback and has no Undo action for archived records', async () => {
    const f = fixture(); await tick(); f.records.push({ id: 'old', noteId: 1, from: 'Inbox/old.md', to: 'Resources/old.md', contentHash: '', createdAt: 1, status: 'archived' });
    vi.mocked(f.controller.confirmMove).mockRejectedValueOnce(new Error('failed')); control(f.container, 'Move to Resources').click(); await tick();
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('could not be completed');
    const history = f.container.querySelector('.note-organizer-recent')!; expect(history.textContent).toContain('previous session'); expect(history.querySelector('button')).toBeNull();
  });
});
