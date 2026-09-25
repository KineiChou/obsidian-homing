// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { App, Plugin as ObsidianPlugin } from 'obsidian';
import { ObsidianOrganizer } from '../src/obsidian/controller';
import { DEFAULT_SETTINGS } from '../src/settings';
import { setLocale } from '../src/i18n';
import { HistoryModal } from '../src/ui/history-modal';
import { renderSettings } from '../src/ui/settings-tab';
import type { OrganizerController } from '../src/ui/types';
import type { MoveRecord } from '../src/filing/types';
import { FakeApp, Plugin, requestUrl, TFolder } from './fakes/obsidian';

const disposals: (() => void)[] = [];
beforeEach(() => { setLocale('en'); requestUrl.mockResolvedValue({ status: 401, headers: {}, json: {} }); });
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); });
async function fixture(settings: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const app = new FakeApp(); app.files.set('Inbox', new TFolder('Inbox')); app.files.set('Resources', new TFolder('Resources'));
  const note = app.add('Inbox/Waiting.md', 'Body'), other = app.add('Resources/Other.md', 'Body');
  const plugin = new Plugin(app); plugin.data = { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS, inbox: 'Inbox', secretName: 'key', ...settings }, filingQueue: [], moveJournal: [] };
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin); await controller.initialize();
  disposals.push(() => { void controller.dispose(); plugin.unload(); });
  const analyze = vi.spyOn(controller.vault, 'note');
  return { app, controller, note, other, analyze };
}

it('analyzes an inbox note without a suggestion once when it is opened', async () => {
  const f = await fixture(); f.controller.setEnabled(true);
  f.app.workspace.emit('file-open', f.other); expect(f.analyze).not.toHaveBeenCalled();
  f.app.workspace.emit('file-open', f.note); await vi.waitFor(() => expect(f.analyze).toHaveBeenCalledExactlyOnceWith('Inbox/Waiting.md', false));
  f.app.workspace.emit('file-open', f.note); expect(f.analyze).toHaveBeenCalledOnce();
});

it('does not analyze on open when the option, automatic filing or this device is off', async () => {
  for (const settings of [{ analyzeOnOpen: false }, { autoFiling: false }]) {
    const f = await fixture(settings); f.controller.setEnabled(true); f.app.workspace.emit('file-open', f.note); expect(f.analyze).not.toHaveBeenCalled();
  }
  const paused = await fixture(); paused.app.workspace.emit('file-open', paused.note); expect(paused.analyze).not.toHaveBeenCalled();
});

it('edits excluded paths as removable rows instead of a text area', async () => {
  const f = await fixture(); const container = document.body.appendChild(document.createElement('div'));
  renderSettings(container, f.app as unknown as App, f.controller);
  expect(container.querySelector('textarea')).toBeNull();
  const add = [...container.querySelectorAll('button')].filter(control => control.textContent === 'Add…')[0]!; add.click();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  [...dialog.querySelectorAll('button')].find(control => control.textContent === 'Resources')!.click();
  await vi.waitFor(() => expect(f.controller.settings().excludedPaths).toEqual(['Resources']));
  const list = container.querySelector('.note-organizer-setting-list')!; expect(list.textContent).toContain('Resources');
  list.querySelector<HTMLButtonElement>('button')!.click();
  await vi.waitFor(() => expect(f.controller.settings().excludedPaths).toEqual([]));
  expect(list.textContent).not.toContain('Resources');
});

it('lists moves needing review first, with undo only for moves from this session', () => {
  const records: MoveRecord[] = [
    { id: 'old', noteId: 1, from: 'Inbox/Old.md', to: 'Resources/Old.md', contentHash: 'h', createdAt: 1, status: 'archived' },
    { id: 'check', noteId: 2, from: 'Inbox/Check.md', to: 'Resources/Check.md', contentHash: 'h', createdAt: 2, status: 'review', message: 'host.referenceReview' },
    { id: 'now', noteId: 3, from: 'Inbox/Now.md', to: 'Resources/Now.md', contentHash: 'h', createdAt: 3, status: 'done' },
  ];
  const controller = { recentMoves: () => records, subscribe: () => () => undefined, undoMove: vi.fn(async () => undefined), acknowledgeMove: vi.fn(async () => undefined) } as unknown as OrganizerController;
  const modal = new HistoryModal({} as App, controller); modal.open();
  expect([...modal.contentEl.querySelectorAll('h3')].map(heading => heading.textContent)).toEqual(['Needs review', 'Recent']);
  const rows = [...modal.contentEl.querySelectorAll('.note-organizer-history-row')];
  expect(rows.map(row => row.querySelector('.note-organizer-history-name')?.textContent)).toEqual(['Check', 'Now', 'Old']);
  expect(rows[0]!.querySelector('button')?.textContent).toBe('Reviewed'); expect(rows[1]!.querySelector('button')?.textContent).toBe('Undo'); expect(rows[2]!.querySelector('button')).toBeNull();
  rows[1]!.querySelector('button')!.click(); expect(controller.undoMove).toHaveBeenCalledWith('now');
});
