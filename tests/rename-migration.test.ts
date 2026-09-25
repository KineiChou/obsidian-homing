import { afterEach, expect, it, vi } from 'vitest';
import type { Plugin as ObsidianPlugin } from 'obsidian';
import { ObsidianOrganizer } from '../src/obsidian/controller';
import { DEFAULT_SETTINGS } from '../src/settings';
import { FakeApp, Plugin, TFolder } from './fakes/obsidian';

const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
async function start(files: Record<string, string>, current: unknown = null) {
  const app = new FakeApp(); app.files.set('Inbox', new TFolder('Inbox'));
  const read = vi.fn(async (path: string) => files[path]!);
  Object.assign(app.vault, { configDir: '.obsidian', adapter: { exists: async (path: string) => path in files, read } });
  const plugin = new Plugin(app); plugin.data = current;
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin); await controller.initialize();
  disposals.push(() => { void controller.dispose(); plugin.unload(); });
  return { controller, plugin, read };
}
const legacy = JSON.stringify({ schemaVersion: 2, settings: { ...DEFAULT_SETTINGS, inbox: 'Inbox', secretName: 'kept' }, filingQueue: [], moveJournal: [] });

it('imports settings from the pre-rename plugin folder when the new one is empty', async () => {
  const f = await start({ '.obsidian/plugins/note-organizer/data.json': legacy });
  expect(f.controller.settings()).toMatchObject({ inbox: 'Inbox', secretName: 'kept' });
  expect(f.read).toHaveBeenCalledExactlyOnceWith('.obsidian/plugins/note-organizer/data.json');
});
it('never reads the old folder once the renamed plugin has its own data', async () => {
  const f = await start({ '.obsidian/plugins/note-organizer/data.json': legacy }, { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS, inbox: '' }, filingQueue: [], moveJournal: [] });
  expect(f.controller.settings().inbox).toBe(''); expect(f.read).not.toHaveBeenCalled();
});
it('starts fresh without old data or with unreadable old data', async () => {
  expect((await start({})).controller.settings().inbox).toBe('');
  expect((await start({ '.obsidian/plugins/note-organizer/data.json': '{broken' })).controller.settings().inbox).toBe('');
});
