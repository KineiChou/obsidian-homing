// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import type { MarkdownFileInfo, Plugin as ObsidianPlugin } from 'obsidian';
import { ObsidianOrganizer } from '../src/obsidian/controller';
import { contentHash } from '../src/core/paths';
import { filingSettingsKey } from '../src/obsidian/settings-impact';
import { DEFAULT_SETTINGS } from '../src/settings';
import { FakeApp, Plugin, TFolder, editorInfoField, requestUrl } from './fakes/obsidian';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('invalidates the actual queue on unsaved editing so folder events cannot revive an old proposal', async () => {
  vi.useFakeTimers(); vi.stubGlobal('requestAnimationFrame', () => 0); vi.stubGlobal('cancelAnimationFrame', () => undefined);
  const app = new FakeApp(); const file = app.add('Inbox/source.md', 'Source note'); app.files.set('Inbox', new TFolder('Inbox')); app.files.set('Resources', new TFolder('Resources'));
  const settings = { ...DEFAULT_SETTINGS, inbox: 'Inbox' }; const plugin = new Plugin(app);
  plugin.data = { schemaVersion: 2, settings, moveJournal: [], filingQueue: [{ path: file.path, status: 'pending', proposal: { contentHash: await contentHash(file.body), selectedPath: 'Resources', ranked: [{ path: 'Resources', probability: 1 }], modelId: settings.modelId, promptRevision: 1, settingsFingerprint: await contentHash(filingSettingsKey(settings)), createdAt: 1 } }] };
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin); await controller.initialize();
  expect(controller.state().filing[0]?.status).toBe('ready');
  const info = { file, editor: { getValue: () => view.state.doc.toString() } } as unknown as MarkdownFileInfo;
  app.workspace.activeEditor = info;
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: file.body, extensions: [markdown(), editorInfoField.init(() => info), controller.editors.extension] }) });
  cleanup.push(() => { view.destroy(); controller.dispose(); plugin.unload(); });
  view.dispatch({ changes: { from: file.body.length, insert: ' changed' } });
  expect(controller.state().filing[0]?.proposal).toBeUndefined();
  await app.vault.createFolder('Other'); expect(controller.state().filing[0]?.status).toBe('waiting'); expect(controller.state().filing[0]?.proposal).toBeUndefined(); expect(requestUrl).not.toHaveBeenCalled();
});
