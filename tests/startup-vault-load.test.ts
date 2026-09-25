import { afterEach, expect, it } from 'vitest';
import type { Plugin as ObsidianPlugin } from 'obsidian';
import { ObsidianOrganizer } from '../src/obsidian/controller';
import { contentHash } from '../src/core/paths';
import { filingSettingsKey } from '../src/obsidian/settings-impact';
import { DEFAULT_SETTINGS } from '../src/settings';
import { FakeApp, Plugin, TFolder } from './fakes/obsidian';

const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

/**
 * Obsidian loads plugins before the vault's file tree: at onload the vault is empty and existing
 * files arrive as create events until the layout is ready. Regression for 0.2.5, where the folder
 * catalog stayed empty after an app restart ("no eligible destination folders").
 */
it('reads folders, restores saved suggestions and checks moves only once the layout is ready', async () => {
  const app = new FakeApp(); let ready: (() => void) | undefined;
  Object.assign(app.workspace, { layoutReady: false, onLayoutReady: (callback: () => void) => { ready = callback; } });
  const settings = { ...DEFAULT_SETTINGS, inbox: 'Inbox', secretName: 'key' }, body = 'Useful reading note';
  const plugin = new Plugin(app);
  plugin.data = { schemaVersion: 2, settings, moveJournal: [], filingQueue: [{ path: 'Inbox/Example.md', status: 'pending', proposal: { contentHash: await contentHash(body), selectedPath: 'Resources/Reading', ranked: [{ path: 'Resources/Reading', probability: 1 }], modelId: settings.modelId, promptRevision: 1, settingsFingerprint: await contentHash(filingSettingsKey(settings)), createdAt: 1 } }] };
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin); await controller.initialize();
  disposals.push(() => { void controller.dispose(); plugin.unload(); });
  // The vault finishes loading after onload: folders and notes appear, then the layout becomes ready.
  for (const path of ['Inbox', 'Resources', 'Resources/Reading', 'Projects']) app.files.set(path, new TFolder(path));
  app.add('Inbox/Example.md', body);
  expect(ready).toBeDefined();
  Object.assign(app.workspace, { layoutReady: true }); ready!();
  await new Promise(resolve => setTimeout(resolve, 0)); await controller.store.flush();
  expect(controller.folders().map(folder => folder.path)).toEqual(['Projects', 'Resources', 'Resources/Reading']);
  expect(controller.state().filing).toMatchObject([{ path: 'Inbox/Example.md', status: 'ready' }]);
  expect(controller.recentMoves()).toEqual([]);
});
