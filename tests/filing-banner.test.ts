// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { MarkdownFileInfo } from 'obsidian';
import { Emitter } from '../src/core/events';
import type { FilingEntry, MovePlan, MoveRecord } from '../src/filing/types';
import { setLocale } from '../src/i18n';
import { filingBanner } from '../src/ui/filing-banner';
import type { OrganizerController } from '../src/ui/types';
import { editorInfoField } from './fakes/obsidian';

const cleanup: (() => void)[] = [];
beforeEach(() => { setLocale('en'); vi.stubGlobal('requestAnimationFrame', () => 0); vi.stubGlobal('cancelAnimationFrame', () => undefined); });
afterEach(() => { for (const close of cleanup.splice(0)) close(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function fixture() {
  const file = { path: 'Inbox/Example.md' }, info = { file } as MarkdownFileInfo, changes = new Emitter();
  const source = { noteId: 1, path: file.path, revision: 1, contentHash: 'hash' };
  let entries: FilingEntry[] = [{ path: file.path, status: 'ready', updatedAt: 1, message: null, proposal: { id: 'proposal', source, foldersRevision: 1, context: { taskId: 'task', settingsRevision: 1, promptRevision: 1, modelId: 'test' }, selected: 'reading', ranked: [] } }];
  const records: MoveRecord[] = [];
  const folders = ['reading', 'projects'].map(id => ({ id, path: id === 'reading' ? 'Reading' : 'Projects', directPurpose: '', effectiveRules: [] }));
  const controller = {
    subscribe: (listener: () => void) => changes.subscribe(listener),
    state: () => ({ filing: entries }), folders: () => folders, recentMoves: () => records,
    prepareMove: vi.fn(async (path: string, folderId: string): Promise<MovePlan> => ({ id: `plan-${folderId}`, source: { ...source, path }, destination: `${folders.find(folder => folder.id === folderId)!.path}/Example.md`, folderId, foldersRevision: 1, settingsRevision: 1 })),
    confirmMove: vi.fn(async (plan: MovePlan) => { records.push({ id: plan.id, noteId: 1, from: file.path, to: plan.destination, contentHash: 'hash', createdAt: 1, status: 'done' }); file.path = plan.destination; entries = []; changes.emit(); }),
    undoMove: vi.fn(async () => undefined),
  };
  const choose = vi.fn<(callback: (id: string) => void) => void>();
  const extension = filingBanner(controller as unknown as OrganizerController, choose);
  const views = [1, 2].map(() => new EditorView({ parent: document.body, state: EditorState.create({ doc: 'Example', extensions: [editorInfoField.init(() => info), extension] }) }));
  cleanup.push(() => views.forEach(view => view.destroy()));
  const panel = (index: number) => views[index]!.dom.querySelector<HTMLElement>('.note-organizer-banner')!;
  const button = (index: number, text: string) => [...panel(index).querySelectorAll('button')].find(button => button.textContent === text)!;
  return { file, views, controller, choose, panel, button, replaceProposal: () => { entries = entries.map(entry => ({ ...entry, proposal: { ...entry.proposal!, id: 'new-proposal' } })); changes.emit(); } };
}
async function settled() { await Promise.resolve(); await Promise.resolve(); }

it('shares a changed destination across split editors and moves only after confirmation', async () => {
  const f = fixture(); await settled();
  f.button(0, 'Other location…').click();
  f.choose.mock.calls[0]![0]('projects'); await settled();
  expect(f.panel(0).textContent).toContain('Projects'); expect(f.panel(1).textContent).toContain('Projects');
  expect(f.controller.confirmMove).not.toHaveBeenCalled(); expect(f.views.every(view => !view.hasFocus)).toBe(true);
  f.button(1, 'File note').click(); await settled();
  expect(f.controller.confirmMove).toHaveBeenCalledOnce();
  expect(f.controller.confirmMove).toHaveBeenCalledWith(expect.objectContaining({ folderId: 'projects', destination: 'Projects/Example.md' }));
});

it('shares dismissal and ignores a picker opened for an obsolete proposal', async () => {
  const f = fixture(); await settled(); f.button(0, 'Other location…').click();
  f.replaceProposal(); f.choose.mock.calls[0]![0]('projects'); await settled();
  expect(f.panel(0).textContent).toContain('Reading'); expect(f.panel(0).textContent).not.toContain('Projects');
  f.button(0, '×').click();
  expect(f.panel(0).hidden).toBe(true); expect(f.panel(1).hidden).toBe(true);
});

it('does not revive an undo banner after switching away and back', async () => {
  const f = fixture(); await settled(); f.button(0, 'File note').click(); await settled();
  expect(f.panel(0).textContent).toContain('Undo');
  f.file.path = 'Other.md'; f.views[0]!.dispatch({});
  f.file.path = 'Reading/Example.md'; f.views[0]!.dispatch({});
  expect(f.panel(0).hidden).toBe(true);
});
