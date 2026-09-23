import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plugin as ObsidianPlugin } from 'obsidian';
import { ObsidianOrganizer } from '../src/obsidian/controller';
import { FakeApp, Plugin, requestUrl, TFolder } from './fakes/obsidian';
import { DEFAULT_SETTINGS } from '../src/settings';

const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); });
beforeEach(() => vi.clearAllMocks());
async function fixture() {
  const app = new FakeApp(); app.files.set('Inbox', new TFolder('Inbox')); app.files.set('Resources', new TFolder('Resources')); const file = app.add('Inbox/Example.md', '---\ntags: ["reading"]\nsecret: private-property\n---\nUseful reading note');
  const plugin = new Plugin(app); plugin.data = { schemaVersion: 1, settings: { ...DEFAULT_SETTINGS, inbox: 'Inbox', secretName: 'key' }, filingQueue: [], moveJournal: [] };
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin); await controller.initialize();
  disposals.push(() => { controller.dispose(); plugin.unload(); });
  return { app, plugin, file, controller, close: () => { controller.dispose(); plugin.unload(); } };
}
describe('Obsidian port integration', () => {
  it('does not read vault bodies or call Jev during metadata initialization', async () => {
    const f = await fixture(); expect(f.app.vault.read).not.toHaveBeenCalled(); expect(requestUrl).not.toHaveBeenCalled(); expect(f.controller.state().filing).toMatchObject([{ path: 'Inbox/Example.md', status: 'waiting' }]); f.close();
  });
  it('runs explicit analysis, strips private properties, confirms once and undoes the current body', async () => {
    vi.useFakeTimers(); const f = await fixture(); const bodies: string[] = [];
    requestUrl.mockImplementation(async ({ body }: { body: string }) => {
      bodies.push(body); const request = JSON.parse(body) as { model: string; questions: Record<string, { criteria: Record<string, unknown> }> };
      return { status: 200, headers: {}, json: { model: request.model, usage: { input_tokens: 25 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => { const ids = Object.keys(question.criteria), selected = ids.find(id => id !== 'unassigned')!; return [id, { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(ids.map(id => [id, id === selected ? 1 : 0])) }]; })) } };
    });
    f.controller.analyzeInbox([f.file.path]); await vi.waitFor(() => expect(f.controller.state().filing[0]?.status).toBe('ready'));
    expect(f.controller.state().filing[0]?.status).toBe('ready'); expect(bodies).toHaveLength(1); expect(bodies[0]).not.toContain('private-property'); expect(bodies[0]).toContain('reading'); expect(f.app.fileManager.renameFile).not.toHaveBeenCalled();
    expect((JSON.parse(bodies[0]!) as { state: unknown }).state).toEqual({ note: { title: 'Example', body: 'Useful reading note', tags: ['reading'] } });
    const target = f.controller.folders()[0]!; const plan = await f.controller.prepareMove(f.file.path, target.id); await f.controller.confirmMove(plan);
    expect(f.file.path).toBe('Resources/Example.md'); expect(f.controller.state().filing.some(entry => entry.status === 'done')).toBe(true);
    f.file.body = 'New content after filing'; f.app.vault.emit('modify', f.file); await f.controller.undoMove(plan.id);
    expect(f.file.path).toBe('Inbox/Example.md'); expect(f.file.body).toBe('New content after filing'); expect(f.app.fileManager.renameFile).toHaveBeenCalledTimes(2); f.close();
  });
  it('rejects excluded source notes and does not automatically analyze existing notes on enable', async () => {
    vi.useFakeTimers(); const f = await fixture(); f.controller.setEnabled(true); await f.app.vault.createFolder('Unrelated'); await f.controller.saveSettings({ autoFiling: false }); await f.controller.saveSettings({ autoFiling: true }); await vi.advanceTimersByTimeAsync(20000); expect(requestUrl).not.toHaveBeenCalled();
    await f.controller.saveSettings({ ...f.controller.settings(), excludedPaths: ['Inbox'] }); f.controller.analyzeInbox([f.file.path]); await vi.advanceTimersByTimeAsync(1); expect(requestUrl).not.toHaveBeenCalled(); f.close();
  });
  it('keeps an invalid persisted configuration intact and makes no requests', async () => {
    const app = new FakeApp(); const plugin = new Plugin(app); plugin.data = { schemaVersion: 900 };
    const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin); await expect(controller.initialize()).rejects.toThrow(); expect(plugin.saveData).not.toHaveBeenCalled(); expect(requestUrl).not.toHaveBeenCalled(); controller.dispose();
  });
  it('blocks a move whose explicit incoming path cannot remain valid', async () => {
    const f = await fixture(); const source = f.app.add('Referencing.md', '[[Inbox/Example]]'); f.app.metadataCache.resolvedLinks[source.path] = { [f.file.path]: 1 }; f.app.caches.set(source, { links: [{ link: 'Inbox/Example' }] });
    await expect(f.controller.prepareMove(f.file.path, f.controller.folders()[0]!.id)).rejects.toMatchObject({ code: 'unsafe' }); expect(f.app.fileManager.renameFile).not.toHaveBeenCalled(); f.close();
  });
  it('merges concurrent settings changes without losing unrelated fields', async () => {
    const f = await fixture();
    await Promise.all([f.controller.saveSettings({ autoLinks: true }), f.controller.saveSettings({ dailyRequestLimit: 40 })]);
    expect(f.controller.settings()).toMatchObject({ autoLinks: true, dailyRequestLimit: 40, inbox: 'Inbox' });
    await expect(f.controller.saveSettings({ dailyRequestLimit: -1 })).rejects.toThrow();
    await f.controller.saveSettings({ includeSubfolders: false });
    expect(f.controller.settings()).toMatchObject({ autoLinks: true, dailyRequestLimit: 40, includeSubfolders: false });
  });
  it('removes all descendant targets when only a directory deletion event arrives', async () => {
    const f = await fixture(); const note = f.app.add('Resources/Concept.md'); f.app.metadataCache.emit('changed', note);
    const id = f.controller.vault.id(note.path)!; expect(f.controller.target(id)).toBeDefined();
    const folder = f.app.files.get('Resources')!; f.app.files.delete(note.path); f.app.files.delete('Resources'); f.app.vault.emit('delete', folder);
    expect(f.controller.target(id)).toBeUndefined(); expect(f.controller.vault.currentPath(id)).toBeNull();
  });
});

function mockClassification(): void {
  requestUrl.mockImplementation(async ({ body }: { body: string }) => {
    const request = JSON.parse(body) as { model: string; questions: Record<string, { criteria: Record<string, unknown> }> };
    return { status: 200, headers: {}, json: { model: request.model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const ids = Object.keys(question.criteria), choice = ids.find(id => id !== 'unassigned')!;
      return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(ids.map(id => [id, id === choice ? 1 : 0])) }];
    })) } };
  });
}

describe('review host fixes', () => {
  it('preserves ready suggestions for unrelated settings and folders, and restores them offline', async () => {
    vi.useFakeTimers(); const f = await fixture(); mockClassification();
    f.controller.analyzeInbox([f.file.path]); await vi.waitFor(() => expect(f.controller.state().filing[0]?.status).toBe('ready'));
    const epoch = f.controller.index.epoch;
    await f.controller.saveSettings({ dailyRequestLimit: 50, autoLinks: true });
    await f.app.vault.createFolder('Other');
    expect(f.controller.state().filing[0]?.status).toBe('ready'); expect(f.controller.index.epoch).toBe(epoch);
    await vi.waitFor(() => expect((f.plugin.data as { filingQueue: { proposal?: unknown }[] }).filingQueue[0]?.proposal).toBeDefined());
    f.close(); requestUrl.mockClear();
    const restored = new ObsidianOrganizer(f.plugin as unknown as ObsidianPlugin); await restored.initialize(); disposals.push(() => restored.dispose());
    expect(restored.state().filing[0]?.status).toBe('ready'); await vi.advanceTimersByTimeAsync(20000); expect(requestUrl).not.toHaveBeenCalled();
    await restored.store.flush(); expect((f.plugin.data as { filingQueue: { proposal?: unknown }[] }).filingQueue[0]?.proposal).toBeDefined();
    restored.dispose(); f.plugin.unload();
    const again = new ObsidianOrganizer(f.plugin as unknown as ObsidianPlugin); await again.initialize(); disposals.push(() => again.dispose());
    expect(again.state().filing[0]?.status).toBe('ready'); await vi.advanceTimersByTimeAsync(20000); expect(requestUrl).not.toHaveBeenCalled();
  });
  it('rejects restored suggestions after source content changes', async () => {
    vi.useFakeTimers(); const f = await fixture(); mockClassification(); f.controller.analyzeNote(f.file.path);
    await vi.waitFor(() => expect(f.controller.state().filing[0]?.status).toBe('ready')); await f.controller.store.flush(); f.close(); f.file.body = 'changed'; requestUrl.mockClear();
    const restored = new ObsidianOrganizer(f.plugin as unknown as ObsidianPlugin); await restored.initialize(); disposals.push(() => restored.dispose());
    expect(restored.state().filing[0]?.status).toBe('waiting'); expect(requestUrl).not.toHaveBeenCalled();
  });
  it('previews only eligible queued notes in recent order and analyzes only selected paths', async () => {
    vi.useFakeTimers(); const f = await fixture(); const newer = f.app.add('Inbox/New.md', 'New'); newer.stat.mtime = 2; f.app.vault.emit('create', newer);
    f.controller.ignoreNote(f.file.path); expect(f.controller.previewAnalysis().notes.map(note => note.path)).toEqual([newer.path]);
    f.controller.analyzeInbox(); await vi.advanceTimersByTimeAsync(1); expect(requestUrl).not.toHaveBeenCalled();
    mockClassification(); f.controller.analyzeInbox([newer.path, f.file.path, 'outside.md']); await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));
  });
  it('truncates preview safely and validates explicit destination creation', async () => {
    const f = await fixture(); f.file.body = 'a'.repeat(19999) + '😀tail';
    const preview = await f.controller.readPreview(f.file.path); expect(preview.text).toHaveLength(19999); expect(preview.truncated).toBe(true);
    await expect(f.controller.createDestination('Inbox/Bad')).rejects.toThrow(); await expect(f.controller.createDestination('../Bad')).rejects.toThrow();
    const folder = await f.controller.createDestination('New destination'); expect(folder.path).toBe('New destination');
  });
  it('permits explicitly enabled link updates and verifies the rewritten references', async () => {
    const f = await fixture(); Object.assign(f.app.vault, { getConfig: () => true });
    const incoming = f.app.add('Reference.md'); f.app.caches.set(incoming, { links: [{ link: 'Inbox/Example' }] }); f.app.metadataCache.resolvedLinks[incoming.path] = { [f.file.path]: 1 };
    const originalRename = f.app.fileManager.renameFile;
    f.app.fileManager.renameFile = vi.fn(async (file, path) => { await originalRename(file, path); f.app.caches.set(incoming, { links: [{ link: 'Resources/Example' }] }); });
    const plan = await f.controller.prepareMove(f.file.path, f.controller.folders()[0]!.id); await f.controller.confirmMove(plan);
    expect(f.controller.recentMoves()[0]?.status).toBe('done');
  });
  it('marks an unverified host link rewrite for review without reversing the move', async () => {
    vi.useFakeTimers(); const f = await fixture(); Object.assign(f.app.vault, { getConfig: () => true });
    const incoming = f.app.add('Reference.md'); f.app.caches.set(incoming, { links: [{ link: 'Inbox/Example' }] }); f.app.metadataCache.resolvedLinks[incoming.path] = { [f.file.path]: 1 };
    const plan = await f.controller.prepareMove(f.file.path, f.controller.folders()[0]!.id);
    const result = f.controller.confirmMove(plan).catch(error => error as Error); await vi.waitFor(() => expect(f.app.fileManager.renameFile).toHaveBeenCalledTimes(1)); await vi.advanceTimersByTimeAsync(1100); expect(await result).toBeInstanceOf(Error);
    expect(f.controller.recentMoves()[0]?.status).toBe('review'); expect(f.app.fileManager.renameFile).toHaveBeenCalledTimes(1);
  });
});
