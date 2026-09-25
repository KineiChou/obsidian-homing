// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { Emitter } from '../src/core/events';
import { OrganizerError } from '../src/core/errors';
import type { FilingEntry, MovePlan } from '../src/filing/types';
import { setLocale } from '../src/i18n';
import { InboxModal } from '../src/ui/inbox-modal';
import type { OrganizerController } from '../src/ui/types';
import { context } from './helpers';

beforeEach(() => setLocale('en'));
afterEach(() => document.body.replaceChildren());
const settled = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function fixture(preselect?: readonly string[], withRanked = false) {
  const changes = new Emitter();
  const ready = (name: string, ranked: number[] = [.9, .1], rankOnly = false): FilingEntry => ({ path: `Inbox/${name}.md`, status: 'ready', updatedAt: 1, message: null, proposal: { id: name, source: { noteId: 1, path: `Inbox/${name}.md`, revision: 1, contentHash: 'h' }, foldersRevision: 1, context, selected: 'reading', ranked: [{ targetId: 'reading', probability: ranked[0]! }, { targetId: 'projects', probability: ranked[1]! }], ...(rankOnly ? { rankOnly } : {}) } });
  let entries: FilingEntry[] = [ready('Alpha'), ready('Beta'), ready('Close', [.45, .4]), { path: 'Inbox/Raw.md', status: 'waiting', updatedAt: 1, message: null }, ...(withRanked ? [ready('Ranked', [2 / 3, 1 / 3], true)] : [])];
  const folders = [{ id: 'reading', path: 'Resources/Reading' }, { id: 'projects', path: 'Projects' }].map(folder => ({ ...folder, directPurpose: '', effectiveRules: [] }));
  const controller = {
    subscribe: (listener: () => void) => changes.subscribe(listener), folders: () => folders,
    state: () => ({ filing: entries, network: { pending: 0, inFlight: false, paused: false, reason: null } }),
    nextInboxNote: () => 'Inbox/Alpha.md', readPreview: vi.fn(async () => ({ text: '---\ntags: [x]\n---\n# Heading\nFirst **paragraph** of text.', truncated: false })),
    prepareMove: vi.fn(async (path: string, folderId: string): Promise<MovePlan> => {
      if (path.includes('Beta')) throw new OrganizerError('conflict', 'error.targetExists');
      return { id: 'plan-' + path, source: { noteId: 1, path, revision: 1, contentHash: 'h' }, destination: `${folders.find(folder => folder.id === folderId)!.path}/${path.split('/').at(-1)}`, folderId, foldersRevision: 1, settingsRevision: 1, attachments: [] };
    }),
    confirmMove: vi.fn(async (plan: MovePlan) => { entries = entries.map(entry => entry.path === plan.source.path ? { path: entry.path, status: 'done', updatedAt: 2, message: null } : entry); changes.emit(); }),
    undoMove: vi.fn(async () => undefined),
  };
  const host = { chooseDestination: vi.fn<(choose: (id: string) => void) => void>(), openNote: vi.fn(), analyze: vi.fn() };
  const modal = new InboxModal({} as App, controller as unknown as OrganizerController, host, preselect); modal.open();
  const rows = () => [...modal.contentEl.querySelectorAll<HTMLElement>('.note-organizer-inbox-row')];
  const row = (name: string) => rows().find(item => item.querySelector('.note-organizer-inbox-title')?.textContent === name)!;
  const button = (text: string, scope: HTMLElement = modal.contentEl) => { const found = [...scope.querySelectorAll('button')].find(item => item.textContent === text); if (!found) throw Error('Missing ' + text); return found; };
  return { modal, controller, host, row, rows, button };
}

it('lists each destination and leaves close calls unselected by default', () => {
  const f = fixture();
  expect(f.modal.contentEl.textContent).toContain('3 suggested · 1 not yet placed');
  expect(f.row('Alpha').textContent).toContain('→ Resources › Reading');
  expect(f.row('Alpha').querySelector('input')!.checked).toBe(true);
  expect(f.row('Close').querySelector('input')!.checked).toBe(false); expect(f.row('Close').textContent).toContain('1 close alternatives');
  expect(f.row('Raw').querySelector('input')).toBeNull(); expect(f.button('File 2 notes').disabled).toBe(false);
});

it('treats ranking-only proposals as clear suggestions instead of close calls', () => {
  const f = fixture(undefined, true);
  expect(f.row('Ranked').querySelector('input')!.checked).toBe(true);
  expect(f.row('Ranked').textContent).not.toContain('close alternatives');
  expect(f.button('File 3 notes').disabled).toBe(false);
});

it('files the selected notes one by one and reports a failure without stopping the batch', async () => {
  const f = fixture(); f.button('File 2 notes').click(); await settled();
  expect(f.controller.prepareMove.mock.calls.map(call => call[0])).toEqual(['Inbox/Alpha.md', 'Inbox/Beta.md']);
  expect(f.controller.confirmMove).toHaveBeenCalledOnce();
  expect(f.row('Alpha').textContent).toContain('Filed to Resources › Reading'); expect(f.row('Beta').querySelector('.note-organizer-feedback')).not.toBeNull();
  expect(f.modal.contentEl.textContent).toContain('Filed 1 of 2 notes.');
  f.button('Undo', f.row('Alpha')).click(); await settled(); expect(f.controller.undoMove).toHaveBeenCalledWith('plan-Inbox/Alpha.md');
});

it('shows a changed destination before filing and honours an explicit preselection', async () => {
  const f = fixture(['Inbox/Close.md']);
  expect(f.row('Alpha').querySelector('input')!.checked).toBe(false); expect(f.row('Close').querySelector('input')!.checked).toBe(true);
  f.button('Change', f.row('Close')).click(); f.host.chooseDestination.mock.calls[0]![0]('projects');
  expect(f.row('Close').textContent).toContain('→ Projects'); expect(f.controller.prepareMove).not.toHaveBeenCalled();
  f.button('File 1 notes').click(); await settled();
  expect(f.controller.prepareMove).toHaveBeenCalledExactlyOnceWith('Inbox/Close.md', 'projects');
});

it('previews plain text, opens a note in the editor, and sends undecided notes to analysis', async () => {
  const f = fixture();
  (f.row('Alpha').querySelector('.note-organizer-icon-button') as HTMLButtonElement).click(); await settled();
  expect(f.row('Alpha').querySelector('.note-organizer-inbox-preview')?.textContent).toBe('Heading First paragraph of text.');
  f.button('Analyze…').click(); expect(f.host.analyze).toHaveBeenCalledWith(['Inbox/Raw.md']);
  f.button('Alpha').click(); expect(f.host.openNote).toHaveBeenCalledWith('Inbox/Alpha.md'); expect(f.modal.contentEl.isConnected).toBe(false);
});


it('locks batch destinations and ignores a picker opened before confirmation', async () => {
  const f = fixture();
  f.button('Change', f.row('Beta')).click();
  const choose = f.host.chooseDestination.mock.calls[0]![0];
  let release!: () => void;
  f.controller.confirmMove.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  f.controller.prepareMove.mockImplementation(async (path, folderId) => ({ id: 'plan-' + path, source: { noteId: 1, path, revision: 1, contentHash: 'h' }, destination: `${folderId === 'projects' ? 'Projects' : 'Resources/Reading'}/${path.split('/').at(-1)}`, folderId, foldersRevision: 1, settingsRevision: 1, attachments: [] }));
  f.button('File 2 notes').click(); await settled();
  const change = f.button('Change', f.row('Beta'));
  expect(change.disabled).toBe(true); change.click();
  expect(f.host.chooseDestination).toHaveBeenCalledOnce();
  choose('projects');
  expect(f.row('Beta').textContent).toContain('→ Resources › Reading');
  release(); await settled();
  expect(f.controller.confirmMove.mock.calls[1]![0].destination).toBe('Resources/Reading/Beta.md');
  f.modal.close();
});

it('binds a manual destination to the current source of an undecided note', async () => {
  const f = fixture([]);
  f.button('Other location…', f.row('Raw')).click();
  f.host.chooseDestination.mock.calls[0]![0]('projects'); await settled();
  expect(f.controller.prepareMove).toHaveBeenCalledExactlyOnceWith('Inbox/Raw.md', 'projects');
  expect(f.row('Raw').textContent).toContain('→ Projects');
  f.button('File 1 notes').click(); await settled();
  expect(f.controller.confirmMove).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ folderId: 'projects', source: expect.objectContaining({ path: 'Inbox/Raw.md', contentHash: 'h' }) }));
  f.modal.close();
});

it('does not start a prepared move after the modal is closed', async () => {
  const f = fixture(['Inbox/Alpha.md']);
  const plan = await f.controller.prepareMove('Inbox/Alpha.md', 'reading');
  let release!: (plan: MovePlan) => void;
  f.controller.prepareMove.mockImplementationOnce(() => new Promise<MovePlan>(resolve => { release = resolve; }));
  f.button('File 1 notes').click(); f.modal.close(); release(plan); await settled();
  expect(f.controller.confirmMove).not.toHaveBeenCalled();
});
