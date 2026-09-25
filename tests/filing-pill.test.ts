// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Emitter } from '../src/core/events';
import type { FilingEntry, MovePlan, MoveRecord } from '../src/filing/types';
import { setLocale } from '../src/i18n';
import { filingPills } from '../src/ui/filing-pill';
import type { OrganizerController } from '../src/ui/types';
import { deferred } from './helpers';

const cleanup: (() => void)[] = [];
beforeEach(() => setLocale('en'));
afterEach(() => { for (const close of cleanup.splice(0)) close(); document.body.replaceChildren(); vi.useRealTimers(); });
const settled = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

function fixture(views = 1) {
  const file = { path: 'Inbox/Example.md' }, changes = new Emitter();
  const source = { noteId: 1, path: file.path, revision: 1, contentHash: 'hash' };
  const proposal = (id = 'proposal') => ({ id, source, foldersRevision: 1, context: { taskId: 'task', settingsRevision: 1, promptRevision: 1, modelId: 'test' }, selected: 'reading', ranked: [{ targetId: 'reading', probability: .5 }, { targetId: 'projects', probability: .4 }] });
  const state = { entries: [{ path: file.path, status: 'ready', updatedAt: 1, message: null, proposal: proposal() }, { path: 'Inbox/Next.md', status: 'ready', updatedAt: 1, message: null, proposal: proposal('next') }] as FilingEntry[] };
  const records: MoveRecord[] = [];
  const folders = [{ id: 'reading', path: 'Resources/Reading' }, { id: 'projects', path: 'Projects' }].map(folder => ({ ...folder, directPurpose: '', effectiveRules: [] }));
  const controller = {
    subscribe: (listener: () => void) => changes.subscribe(listener),
    state: () => ({ filing: state.entries }), folders: () => folders, recentMoves: () => records, attachmentCount: () => 2,
    nextInboxNote: () => state.entries.find(entry => entry.path !== file.path && entry.status === 'ready')?.path ?? null,
    prepareMove: vi.fn(async (path: string, folderId: string): Promise<MovePlan> => ({ id: `plan-${folderId}`, source: { ...source, path }, destination: `${folders.find(folder => folder.id === folderId)!.path}/Example.md`, folderId, foldersRevision: 1, settingsRevision: 1, attachments: [{ from: 'Inbox/a.png', to: 'Resources/Reading/a.png' }] })),
    confirmMove: vi.fn(async (plan: MovePlan) => { records.push({ id: plan.id, noteId: 1, from: file.path, to: plan.destination, contentHash: 'hash', createdAt: 1, status: 'done' }); file.path = plan.destination; state.entries = state.entries.filter(entry => entry.path !== source.path); changes.emit(); }),
    undoMove: vi.fn(async () => undefined), analyzeNote: vi.fn(), ignoreNote: vi.fn(),
  };
  const host = { chooseDestination: vi.fn<(choose: (id: string) => void) => void>(), menu: vi.fn(), openNote: vi.fn() };
  const pills = filingPills(controller as unknown as OrganizerController, host);
  // Each surface stands for one Markdown view's content container, whatever its reading or editing mode.
  const surfaces = Array.from({ length: views }, () => {
    const parent = document.body.appendChild(document.createElement('div')); let current: { path: string } | null = file;
    const surface = { parent, file: () => current, hasFocus: () => false, focusNote: vi.fn(), openNote: (path: string) => host.openNote(parent, path), show: (next: { path: string } | null) => { current = next; pills.refresh(); } };
    cleanup.push(pills.attach(surface)); return surface;
  });
  const editors = surfaces.map(surface => ({ dom: surface.parent }));
  const pill = (index = 0) => surfaces[index]!.parent.querySelector<HTMLElement>('.note-organizer-pill-host')!;
  const button = (text: string, index = 0) => { const found = [...pill(index).querySelectorAll('button')].find(item => item.textContent?.startsWith(text)); if (!found) throw Error('Missing ' + text); return found; };
  return { file, state, editors, surfaces, controller, host, pills, pill, button, proposal, emit: () => changes.emit() };
}

it('floats a quiet suggestion that prepares and moves only after explicit confirmation', async () => {
  const f = fixture(); await settled();
  expect(f.pill().textContent).toBe('→ Reading'); expect(f.pill().parentElement).toBe(f.editors[0]!.dom);
  expect(f.editors[0]!.dom.classList.contains('note-organizer-pill-parent')).toBe(true); expect(f.controller.prepareMove).not.toHaveBeenCalled();
  f.button('→ Reading').click(); await settled();
  expect(f.pill().textContent).toContain('Resources › Reading'); expect(f.pill().textContent).toContain('1 attachments move with the note · 1 attachments stay');
  expect(f.pill().textContent).toContain('Also consider'); expect(f.controller.confirmMove).not.toHaveBeenCalled();
  f.button('File note').click(); await settled();
  expect(f.controller.confirmMove).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ folderId: 'reading' }));
  expect(f.pill().textContent).toContain('Filed to Resources › Reading'); expect(f.surfaces[0]!.focusNote).not.toHaveBeenCalled();
});

it('guards the done state before offering undo and the next inbox note in the same pane', async () => {
  vi.useFakeTimers(); const f = fixture(); await settled();
  f.button('→ Reading').click(); await settled(); f.button('File note').click(); await settled();
  expect(f.button('Undo').disabled).toBe(true); expect(f.button('Next').disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(401);
  expect(f.button('Next · 1 left').disabled).toBe(false); f.button('Next').click();
  expect(f.host.openNote).toHaveBeenCalledExactlyOnceWith(f.editors[0]!.dom, 'Inbox/Next.md');
  f.button('Undo').click(); await settled(); expect(f.controller.undoMove).toHaveBeenCalledWith('plan-reading');
});

it('shares a changed destination across split editors and ignores choices for obsolete suggestions', async () => {
  const f = fixture(2); await settled();
  f.button('→ Reading').click(); await settled(); f.button('Other location…').click();
  f.host.chooseDestination.mock.calls[0]![0]('projects'); await settled();
  expect(f.pill(0).textContent).toContain('Projects'); expect(f.pill(1).textContent).toBe('→ Projects');
  expect(f.controller.confirmMove).not.toHaveBeenCalled();
  f.button('Other location…').click(); f.state.entries[0] = { ...f.state.entries[0]!, proposal: f.proposal('replaced') }; f.emit();
  f.host.chooseDestination.mock.calls[1]![0]('projects'); await settled();
  expect(f.pill(1).textContent).toBe('→ Reading');
});

it('opens from the command only when the active note has a suggestion, and closes with Escape', async () => {
  const f = fixture(); await settled();
  expect(f.pills.open('Elsewhere.md', true)).toBe(false); expect(f.pills.open(f.file.path, true)).toBe(true);
  expect(f.pill().querySelector('.note-organizer-popover')).toBeNull();
  f.pills.open(f.file.path); await settled(); expect(document.activeElement?.textContent).toBe('File note');
  f.pill().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(f.pill().querySelector('.note-organizer-popover')).toBeNull(); expect(f.surfaces[0]!.focusNote).toHaveBeenCalledOnce();
});

it('stays hidden outside the inbox and offers manual filing for undecided notes', async () => {
  const f = fixture(); f.state.entries = [{ path: f.file.path, status: 'unassigned', updatedAt: 1, message: null }]; f.emit(); await settled();
  expect(f.pill().textContent).toBe('File…'); f.button('File…').click();
  f.button('Analyze').click(); expect(f.controller.analyzeNote).toHaveBeenCalledWith(f.file.path);
  f.state.entries = []; f.emit(); expect(f.pill().hidden).toBe(true);
});

it('keeps the filed result through the rename but clears it after switching to another note', async () => {
  const f = fixture(); await settled(); f.button('→ Reading').click(); await settled(); f.button('File note').click(); await settled();
  f.pills.refresh(); expect(f.pill().textContent).toContain('Filed to');
  f.surfaces[0]!.show({ path: 'Other.md' }); expect(f.pill().hidden).toBe(true);
  f.surfaces[0]!.show(f.file); expect(f.pill().hidden).toBe(true);
});


it('reports a persistent preparation error without retrying by itself', async () => {
  const f = fixture();
  f.controller.prepareMove.mockImplementation(() => f.controller.prepareMove.mock.calls.length < 4
    ? Promise.reject(new Error('persistent destination conflict'))
    : new Promise<MovePlan>(() => undefined));
  f.button('→ Reading').click();
  await settled(); await settled();
  expect(f.controller.prepareMove).toHaveBeenCalledTimes(1);
});

it('displays failed undo feedback immediately', async () => {
  vi.useFakeTimers(); const f = fixture();
  f.button('→ Reading').click(); await settled(); f.button('File note').click(); await settled();
  await vi.advanceTimersByTimeAsync(401);
  f.controller.undoMove.mockRejectedValue(new Error('destination occupied'));
  f.button('Undo').click(); await settled();
  expect(f.pill().querySelector('.note-organizer-feedback')).not.toBeNull();
  expect(f.button('Undo').disabled).toBe(false);
  f.button('Undo').click(); await settled();
  expect(f.controller.undoMove).toHaveBeenCalledTimes(2);
  expect(f.button('Undo').disabled).toBe(false);
});

it('keeps a pending move and its late error attached to the note that started it', async () => {
  const f = fixture(), pending = deferred<void>();
  f.controller.confirmMove.mockReturnValue(pending.promise);
  f.button('→ Reading').click(); await settled(); f.button('File note').click();
  f.surfaces[0]!.show({ path: 'Inbox/Next.md' });
  expect(f.pill().textContent).toBe('→ Reading');
  f.button('→ Reading').click(); await settled();
  pending.reject(new Error('Previous note could not move')); await settled();
  expect(f.pill().textContent).not.toContain('Previous note');
  expect(f.button('File note').disabled).toBe(false);
});

it('ignores late undo errors after switching to a different note', async () => {
  vi.useFakeTimers(); const f = fixture(), pending = deferred<undefined>();
  f.button('→ Reading').click(); await settled(); f.button('File note').click(); await settled();
  await vi.advanceTimersByTimeAsync(401);
  f.controller.undoMove.mockReturnValue(pending.promise); f.button('Undo').click();
  f.surfaces[0]!.show({ path: 'Inbox/Next.md' }); f.button('→ Reading').click(); await settled();
  pending.reject(new Error('Previous undo failed')); await settled();
  expect(f.pill().textContent).not.toContain('Previous undo');
  expect(f.button('File note').disabled).toBe(false);
});
