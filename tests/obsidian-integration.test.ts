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
    const f = await fixture(); expect(f.app.vault.read).not.toHaveBeenCalled(); expect(requestUrl).not.toHaveBeenCalled(); expect(f.controller.state().filing).toEqual([]); f.close();
  });
  it('runs explicit analysis, strips private properties, confirms once and undoes the current body', async () => {
    vi.useFakeTimers(); const f = await fixture(); const bodies: string[] = [];
    requestUrl.mockImplementation(async ({ body }: { body: string }) => {
      bodies.push(body); const request = JSON.parse(body) as { model: string; questions: Record<string, { criteria: Record<string, unknown> }> };
      return { status: 200, headers: {}, json: { model: request.model, usage: { input_tokens: 25 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => { const ids = Object.keys(question.criteria), selected = ids.find(id => id !== 'unassigned')!; return [id, { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(ids.map(id => [id, id === selected ? 1 : 0])) }]; })) } };
    });
    f.controller.analyzeInbox(); await vi.waitFor(() => expect(f.controller.state().filing[0]?.status).toBe('ready'));
    expect(f.controller.state().filing[0]?.status).toBe('ready'); expect(bodies).toHaveLength(1); expect(bodies[0]).not.toContain('private-property'); expect(bodies[0]).toContain('reading'); expect(f.app.fileManager.renameFile).not.toHaveBeenCalled();
    expect((JSON.parse(bodies[0]!) as { state: unknown }).state).toEqual({ note: { title: 'Example', body: 'Useful reading note', tags: ['reading'] } });
    const target = f.controller.folders()[0]!; const plan = await f.controller.prepareMove(f.file.path, target.id); await f.controller.confirmMove(plan);
    expect(f.file.path).toBe('Resources/Example.md'); expect(f.controller.state().filing.some(entry => entry.status === 'done')).toBe(true);
    f.file.body = 'New content after filing'; f.app.vault.emit('modify', f.file); await f.controller.undoMove(plan.id);
    expect(f.file.path).toBe('Inbox/Example.md'); expect(f.file.body).toBe('New content after filing'); expect(f.app.fileManager.renameFile).toHaveBeenCalledTimes(2); f.close();
  });
  it('rejects excluded source notes and does not automatically analyze existing notes on enable', async () => {
    vi.useFakeTimers(); const f = await fixture(); f.controller.setEnabled(true); await vi.advanceTimersByTimeAsync(20000); expect(requestUrl).not.toHaveBeenCalled();
    await f.controller.saveSettings({ ...f.controller.settings(), excludedPaths: ['Inbox'] }); f.controller.analyzeInbox(); await vi.advanceTimersByTimeAsync(1); expect(requestUrl).not.toHaveBeenCalled(); f.close();
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
