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
  await Promise.resolve(); await Promise.resolve();
  const savesBeforeEdit = plugin.saveData.mock.calls.length;
  view.dispatch({ changes: { from: file.body.length, insert: ' changed' } });
  await Promise.resolve(); await Promise.resolve();
  expect(plugin.saveData.mock.calls.length).toBe(savesBeforeEdit + 1);
  for (let i = 0; i < 20; i++) view.dispatch({ changes: { from: view.state.doc.length, insert: 'x' } });
  await Promise.resolve(); await Promise.resolve();
  expect(plugin.saveData.mock.calls.length).toBe(savesBeforeEdit + 1);
  expect(controller.state().filing[0]?.proposal).toBeUndefined();
  await app.vault.createFolder('Other'); expect(controller.state().filing[0]?.status).toBe('waiting'); expect(controller.state().filing[0]?.proposal).toBeUndefined(); expect(requestUrl).not.toHaveBeenCalled();
});

it('uses sentence-only cached decisions, maps visible suggestions and confirms selected links atomically', async () => {
  vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('requestAnimationFrame', () => 0); vi.stubGlobal('cancelAnimationFrame', () => undefined);
  const app = new FakeApp(); const file = app.add('Inbox/source.md', 'Private unrelated sentence.Transformer explains this. Attention supports this. Learning matters.');
  for (const name of ['Transformer', 'Attention', 'Learning']) app.add(`Resources/${name}.md`);
  app.files.set('Inbox', new TFolder('Inbox')); app.files.set('Resources', new TFolder('Resources'));
  const plugin = new Plugin(app); plugin.data = { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS, inbox: 'Inbox', secretName: 'key', autoFiling: false }, filingQueue: [], moveJournal: [] };
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin); await controller.initialize();
  let undoChanges: import('@codemirror/state').ChangeSet | undefined;
  const editor = {
    getValue: () => view.state.doc.toString(),
    offsetToPos: (offset: number) => { const line = view.state.doc.lineAt(offset); return { line: line.number - 1, ch: offset - line.from }; },
    transaction: vi.fn((spec: import('obsidian').EditorTransaction) => {
      const changes = (spec.changes ?? []).map(change => ({ from: view.state.doc.line(change.from.line + 1).from + change.from.ch, to: change.to ? view.state.doc.line(change.to.line + 1).from + change.to.ch : undefined, insert: change.text }));
      const transaction = view.state.update({ changes }); undoChanges = transaction.changes.invert(view.state.doc); view.dispatch(transaction);
    }),
  };
  const info = { file, editor } as unknown as MarkdownFileInfo; app.workspace.activeEditor = info;
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: file.body, extensions: [markdown(), editorInfoField.init(() => info), controller.editors.extension] }) });
  cleanup.push(() => { view.destroy(); controller.dispose(); plugin.unload(); });
  app.workspace.emit('file-open', file);
  requestUrl.mockImplementation(async ({ body }: { body: string }) => {
    const request = JSON.parse(body) as { model: string; questions: Record<string, { criteria: Record<string, unknown> }> };
    return { status: 200, headers: {}, json: { model: request.model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const ids = Object.keys(question.criteria), choice = ids.find(id => id !== 'unassigned')!;
      return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(ids.map(id => [id, id === choice ? 1 : 0])) }];
    })) } };
  });
  await vi.waitFor(() => expect(controller.state().indexReady).toBe(true));
  await controller.findLinks();
  expect(controller.state().links).toHaveLength(3);
  expect(requestUrl).toHaveBeenCalledTimes(1);
  expect(requestUrl.mock.calls[0]![0].body).not.toContain('Private unrelated sentence');
  const previous = controller.state().links.map(link => link.id);
  view.dispatch({ changes: { from: 0, insert: 'Changed ' } });
  expect(controller.state().links.map(link => link.id)).toEqual(previous);
  await controller.findLinks();
  expect(requestUrl).toHaveBeenCalledTimes(1);
  const selected = controller.state().links.filter((_, index) => index !== 1);
  const plans = selected.map(proposal => controller.prepareLink(proposal, proposal.selected!));
  const result = controller.confirmLinks(plans);
  expect(result.appliedPlanIds).toHaveLength(2); expect(result.failures).toEqual([]);
  expect(editor.transaction).toHaveBeenCalledTimes(1);
  view.dispatch({ changes: undoChanges!, userEvent: 'undo' });
  const session = controller.editors.active(file.path)!;
  for (const proposal of selected) expect(session.suppressed(proposal.input.anchor)).toBe(true);
});
