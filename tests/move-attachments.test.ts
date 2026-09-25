// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { Plugin as ObsidianPlugin } from 'obsidian';
import { ObsidianOrganizer } from '../src/obsidian/controller';
import { isAttachmentFolder, noteAttachmentFolder } from '../src/core/paths';
import { DEFAULT_SETTINGS } from '../src/settings';
import { FakeApp, Plugin, TFolder } from './fakes/obsidian';

const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

it('follows only attachment locations that move with notes', () => {
  expect(noteAttachmentFolder('./', 'Resources/Note.md')).toBe('Resources');
  expect(noteAttachmentFolder('./assets/', 'Resources/Note.md')).toBe('Resources/assets');
  expect(noteAttachmentFolder('./assets', 'Note.md')).toBe('assets');
  expect(noteAttachmentFolder('/', 'Resources/Note.md')).toBeNull(); expect(noteAttachmentFolder('Attachments', 'Resources/Note.md')).toBeNull();
  expect(isAttachmentFolder('./assets', 'Resources/assets')).toBe(true); expect(isAttachmentFolder('./assets', 'Resources/assets-old')).toBe(false);
  expect(isAttachmentFolder('Attachments', 'Attachments/2026')).toBe(true); expect(isAttachmentFolder('./', 'Resources')).toBe(false); expect(isAttachmentFolder('/', 'Resources')).toBe(false);
});

async function fixture(setting: unknown, automatic = true) {
  const app = new FakeApp(); app.config.set('attachmentFolderPath', setting); app.config.set('alwaysUpdateLinks', automatic);
  for (const path of ['Inbox', 'Inbox/assets', 'Resources', 'Resources/assets']) app.files.set(path, new TFolder(path));
  const note = app.add('Inbox/Note.md', '![[photo.png]] ![[Inbox/assets/chart.png]] [[paper.pdf]] ![[shared.png]] ![[Elsewhere/logo.png]]');
  const files = Object.fromEntries(['Inbox/assets/photo.png', 'Inbox/assets/chart.png', 'Inbox/paper.pdf', 'Inbox/assets/shared.png', 'Elsewhere/logo.png'].map(path => [path, app.add(path)]));
  const other = app.add('Inbox/Other.md');
  app.caches.set(note, { embeds: [{ link: 'photo.png' }, { link: 'Inbox/assets/chart.png' }, { link: 'shared.png' }, { link: 'Elsewhere/logo.png' }], links: [{ link: 'paper.pdf' }] });
  app.metadataCache.resolvedLinks = { 'Inbox/Note.md': { 'Inbox/assets/photo.png': 1, 'Inbox/assets/chart.png': 1, 'Inbox/paper.pdf': 1, 'Inbox/assets/shared.png': 1, 'Elsewhere/logo.png': 1 }, 'Inbox/Other.md': { 'Inbox/assets/shared.png': 1 } };
  const plugin = new Plugin(app); plugin.data = { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS, inbox: 'Inbox', secretName: 'key', autoFiling: false }, filingQueue: [], moveJournal: [] };
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin); await controller.initialize();
  disposals.push(() => { void controller.dispose(); plugin.unload(); });
  const folder = (path: string) => controller.folders().find(item => item.path === path)!.id;
  return { app, controller, note, files, other, folder };
}

it('moves attachments only this inbox note uses into the attachment folder next to its destination, and back on undo', async () => {
  const f = await fixture('./assets');
  // Attachment folders are never filing destinations.
  expect(f.controller.folders().map(item => item.path)).toEqual(['Resources']);
  const plan = await f.controller.prepareMove('Inbox/Note.md', f.folder('Resources'));
  expect(plan.attachments).toEqual([
    { from: 'Inbox/assets/chart.png', to: 'Resources/assets/chart.png' },
    { from: 'Inbox/assets/photo.png', to: 'Resources/assets/photo.png' },
    { from: 'Inbox/paper.pdf', to: 'Resources/assets/paper.pdf' },
  ]);
  await f.controller.confirmMove(plan);
  expect(f.note.path).toBe('Resources/Note.md');
  expect([f.files['Inbox/assets/photo.png']!.path, f.files['Inbox/paper.pdf']!.path, f.files['Inbox/assets/shared.png']!.path, f.files['Elsewhere/logo.png']!.path]).toEqual(['Resources/assets/photo.png', 'Resources/assets/paper.pdf', 'Inbox/assets/shared.png', 'Elsewhere/logo.png']);
  // Obsidian rewrites the path link on rename; the fake keeps only names, so update that one link.
  f.app.caches.set(f.note, { ...f.app.caches.get(f.note), embeds: [{ link: 'photo.png' }, { link: 'Resources/assets/chart.png' }, { link: 'shared.png' }, { link: 'Elsewhere/logo.png' }] });
  const record = f.controller.recentMoves().find(item => item.status === 'done')!;
  expect(record.attachments).toHaveLength(3); expect(record.message).toBeUndefined();
  await f.controller.undoMove(record.id);
  expect([f.note.path, f.files['Inbox/assets/photo.png']!.path, f.files['Inbox/assets/chart.png']!.path, f.files['Inbox/paper.pdf']!.path]).toEqual(['Inbox/Note.md', 'Inbox/assets/photo.png', 'Inbox/assets/chart.png', 'Inbox/paper.pdf']);
});

it('creates the attachment folder only after confirmation and keeps an attachment whose name is taken', async () => {
  const f = await fixture('./files');
  f.app.add('Resources/files/photo.png');
  const plan = await f.controller.prepareMove('Inbox/Note.md', f.folder('Resources'));
  expect(plan.attachments.map(item => item.to)).toEqual(['Resources/files/chart.png', 'Resources/files/paper.pdf']);
  expect(f.app.files.has('Resources/files')).toBe(false);
  await f.controller.confirmMove(plan);
  expect(f.app.files.get('Resources/files')).toBeInstanceOf(TFolder);
  expect(f.files['Inbox/assets/photo.png']!.path).toBe('Inbox/assets/photo.png');
});

it('leaves attachments in place when Obsidian keeps them in the vault root or a fixed folder', async () => {
  for (const setting of ['/', 'Attachments', undefined]) {
    const f = await fixture(setting);
    expect((await f.controller.prepareMove('Inbox/Note.md', f.folder('Resources'))).attachments).toEqual([]);
  }
});

it('without automatic link updates moves only attachments linked by a unique file name', async () => {
  const f = await fixture('./', false);
  expect((await f.controller.prepareMove('Inbox/Note.md', f.folder('Resources'))).attachments).toEqual([
    { from: 'Inbox/assets/photo.png', to: 'Resources/photo.png' }, { from: 'Inbox/paper.pdf', to: 'Resources/paper.pdf' },
  ]);
  f.app.add('Archive/photo.png');
  expect((await f.controller.prepareMove('Inbox/Note.md', f.folder('Resources'))).attachments).toEqual([{ from: 'Inbox/paper.pdf', to: 'Resources/paper.pdf' }]);
});

it('rejects a confirmed plan whose attachments changed and records attachments that could not move', async () => {
  const f = await fixture('./assets');
  const stale = await f.controller.prepareMove('Inbox/Note.md', f.folder('Resources'));
  f.app.metadataCache.resolvedLinks['Inbox/Other.md']!['Inbox/paper.pdf'] = 1;
  await expect(f.controller.confirmMove(stale)).rejects.toThrow(); expect(f.note.path).toBe('Inbox/Note.md');
  const plan = await f.controller.prepareMove('Inbox/Note.md', f.folder('Resources'));
  const rename = f.app.fileManager.renameFile.getMockImplementation()!;
  f.app.fileManager.renameFile.mockImplementation(async (file, path) => { if (path.endsWith('chart.png')) throw Error('locked'); return rename(file, path); });
  await f.controller.confirmMove(plan);
  const record = f.controller.recentMoves().find(item => item.status === 'done')!;
  expect(record.attachments).toEqual([{ from: 'Inbox/assets/photo.png', to: 'Resources/assets/photo.png' }]); expect(record.message).toBe('move.attachmentsKept');
  expect(f.files['Inbox/assets/chart.png']!.path).toBe('Inbox/assets/chart.png'); vi.restoreAllMocks();
});
