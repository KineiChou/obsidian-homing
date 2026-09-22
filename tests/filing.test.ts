import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryFolderCatalog } from '../src/folders/catalog';
import { PluginStateStore } from '../src/storage/state-store';
import { StableInboxQueue } from '../src/filing/inbox-queue';
import { ConfirmedMoveService } from '../src/filing/move-service';
import { DEFAULT_SETTINGS, parseSettings } from '../src/settings';
import { inInbox, contentHash } from '../src/core/paths';
import type { FilingProposal, MoveHost } from '../src/filing/types';
import { context, deferred, memoryPort, note } from './helpers';

const settings = { ...DEFAULT_SETTINGS, inbox: 'Inbox' };
const proposal = (): FilingProposal => ({ id: 'proposal', source: note.source, foldersRevision: 1, context, selected: 'f1', ranked: [{ targetId: 'f1', probability: 1 }] });
afterEach(() => vi.useRealTimers());

describe('folder scope', () => {
  it('respects path boundaries, container rules and full depth', () => {
    expect(inInbox('Inbox-old/n.md', 'Inbox', true)).toBe(false); expect(inInbox('Inbox/sub/n.md', 'Inbox', false)).toBe(false);
    const catalog = new MemoryFolderCatalog();
    catalog.refresh(['Inbox', 'Inbox/sub', 'Inbox-old', 'Area', 'Area/Leaf', 'Private', 'Private/Leaf'], { ...settings, excludedPaths: ['Private'], folderRules: [{ path: 'Area', acceptsNotes: false, purpose: 'container', subtreeRules: ['work'] }] });
    expect(catalog.snapshot().targets.map(target => target.path)).toEqual(['Area/Leaf', 'Inbox-old']); expect(catalog.snapshot().targets[0]?.effectiveRules).toEqual(['work']);
  });
  it('keeps stable IDs and revisions and permits a folder named unassigned', () => {
    const catalog = new MemoryFolderCatalog(); const paths = ['Area', 'Area/Empty', 'unassigned', '长'.repeat(220)];
    catalog.refresh(paths, settings); const before = catalog.snapshot(); catalog.refresh([...paths].reverse(), settings);
    expect(catalog.snapshot()).toEqual(before); expect(before.targets.every(target => target.id.length < 200 && target.id !== 'unassigned')).toBe(true);
    const copy = catalog.snapshot(); (copy.targets as unknown[]).pop(); expect(catalog.snapshot().targets).toHaveLength(4);
  });
  it.each(['', '/', '../outside', 'Inbox/../Private', '/absolute', '.obsidian', 'C:\\notes'])('rejects invalid configured inbox %s', inbox => {
    if (inbox === '') expect(parseSettings({ inbox }).inbox).toBe(''); else expect(() => parseSettings({ inbox })).toThrow();
  });
});

describe('durable state and quota', () => {
  it('serializes concurrent updates without dropping settings or queue', async () => {
    const memory = memoryPort(); const store = new PluginStateStore(memory.port); await store.load();
    await Promise.all([store.updateSettings(settings), store.updateQueue([{ path: note.source.path, status: 'ignored' }])]);
    expect(store.snapshot().settings.inbox).toBe('Inbox'); expect(store.snapshot().filingQueue[0]?.status).toBe('ignored'); expect(store.automaticEnabled()).toBe(false);
    store.setAutomaticEnabled(true); expect(store.automaticEnabled()).toBe(true);
  });
  it('preserves corrupt state and recovers from a failed save without committing it', async () => {
    const corrupt = memoryPort({ schemaVersion: 99 }); const invalid = new PluginStateStore(corrupt.port); await expect(invalid.load()).rejects.toMatchObject({ code: 'storage' }); expect(corrupt.port.save).not.toHaveBeenCalled();
    const memory = memoryPort(); const store = new PluginStateStore(memory.port); await store.load(); vi.mocked(memory.port.save).mockRejectedValueOnce(new Error('disk'));
    await expect(store.updateSettings(settings)).rejects.toThrow(); expect(store.snapshot().settings.inbox).toBe(''); await store.updateSettings(settings); expect(store.snapshot().settings.inbox).toBe('Inbox');
  });
  it('accounts unknown requests and honors per-day limits including restart', async () => {
    let date = new Date(2026, 8, 22); const memory = memoryPort(); const store = new PluginStateStore(memory.port, () => date); await store.load();
    await store.usage.reserve(1); expect(store.usage.read().unknownRequests).toBe(1); await expect(store.usage.reserve(1)).rejects.toMatchObject({ code: 'budget' });
    const restarted = new PluginStateStore(memory.port, () => date); await restarted.load(); await expect(restarted.usage.reserve(1)).rejects.toThrow();
    date = new Date(2026, 8, 23); await store.usage.reserve(1); await store.usage.settle(99); expect(store.usage.read()).toMatchObject({ requests: 1, inputTokens: 0, unknownRequests: 1 }); await store.usage.settle(3); expect(store.usage.read().inputTokens).toBe(3);
    date = new Date(2026, 8, 22); await expect(store.usage.reserve(1)).rejects.toThrow();
  });
});

describe('inbox lifecycle', () => {
  it('does not analyze historical items or ignored edits; waits for active editing', async () => {
    vi.useFakeTimers(); let editing = true; const propose = vi.fn(async () => proposal());
    const queue = new StableInboxQueue({ eligible: path => inInbox(path, 'Inbox', true), automaticEnabled: () => true, isEditing: () => editing, propose, persist: async () => undefined, stableMs: 100 });
    queue.restore([{ path: 'Inbox/old.md', status: 'pending' }]); await vi.advanceTimersByTimeAsync(1000); expect(propose).not.toHaveBeenCalled();
    queue.touch(note.source.path, true); await vi.advanceTimersByTimeAsync(100); expect(propose).not.toHaveBeenCalled(); editing = false; await vi.advanceTimersByTimeAsync(100); expect(propose).toHaveBeenCalledTimes(1);
    queue.ignore(note.source.path); queue.touch(note.source.path, true); await vi.advanceTimersByTimeAsync(200); expect(propose).toHaveBeenCalledTimes(1); queue.dispose();
  });
  it('discards responses after source rename and respects restored ignores', async () => {
    vi.useFakeTimers(); const result = deferred<FilingProposal>(); const queue = new StableInboxQueue({ eligible: path => inInbox(path, 'Inbox', true), automaticEnabled: () => true, isEditing: () => false, propose: () => result.promise, persist: async () => undefined });
    queue.analyze(note.source.path); await vi.advanceTimersByTimeAsync(0); queue.rename(note.source.path, 'Inbox/new.md'); result.resolve(proposal()); await Promise.resolve();
    expect(queue.entries().some(entry => entry.status === 'ready')).toBe(false); queue.ignore('Inbox/new.md'); queue.resume('Inbox/new.md'); await vi.advanceTimersByTimeAsync(20000); expect(queue.entries()[0]?.status).toBe('waiting'); queue.dispose();
  });
});

export async function moveFixture() {
  const memory = memoryPort(); const store = new PluginStateStore(memory.port); await store.load(); await store.updateSettings(settings);
  const catalog = new MemoryFolderCatalog(); catalog.refresh(['Inbox', 'Resources'], settings);
  let path = note.source.path, body = note.body, revision = 1, configuration = 0;
  const occupied = new Set<string>();
  const host: MoveHost = {
    source: async requested => requested === path ? { noteId: 10, path, revision, contentHash: await contentHash(body) } : null,
    currentPath: id => id === 10 ? path : null, exists: requested => requested === path || occupied.has(requested), eligible: requested => inInbox(requested, 'Inbox', true), referencesSafe: () => true,
    rename: vi.fn(async (from, to) => { if (from !== path || occupied.has(to)) throw Error('conflict'); path = to; revision++; }), folders: () => catalog.snapshot(), settingsRevision: () => configuration,
  };
  return { memory, store, host, catalog, service: new ConfirmedMoveService(host, store.journal), occupied, path: () => path, body: () => body, edit: (text: string) => { body = text; revision++; }, configure: () => { configuration++; } };
}

describe('confirmed moves', () => {
  it('requires a preview, executes once, and undo preserves the latest body', async () => {
    const f = await moveFixture(); const plan = await f.service.prepare(f.path(), f.catalog.snapshot().targets[0]!.id);
    expect(f.host.rename).not.toHaveBeenCalled(); expect((await f.service.confirm(plan.id)).status).toBe('done'); expect((await f.service.confirm(plan.id)).status).toBe('stale'); expect(f.host.rename).toHaveBeenCalledTimes(1);
    f.edit('newer content'); expect((await f.service.undo(plan.id)).status).toBe('done'); expect(f.path()).toBe(note.source.path); expect(f.body()).toBe('newer content');
  });
  it.each(['edit', 'config', 'conflict'] as const)('rejects changed %s before writing', async change => {
    const f = await moveFixture(); const plan = await f.service.prepare(f.path(), f.catalog.snapshot().targets[0]!.id);
    if (change === 'edit') f.edit('different'); if (change === 'config') f.configure(); if (change === 'conflict') f.occupied.add(plan.destination);
    expect((await f.service.confirm(plan.id)).status).not.toBe('done'); expect(f.host.rename).not.toHaveBeenCalled();
  });
  it('never moves when intent persistence fails', async () => {
    const f = await moveFixture(); const plan = await f.service.prepare(f.path(), f.catalog.snapshot().targets[0]!.id); vi.mocked(f.memory.port.save).mockRejectedValueOnce(new Error('disk'));
    expect((await f.service.confirm(plan.id)).status).toBe('failed'); expect(f.host.rename).not.toHaveBeenCalled();
  });
  it('does not repeat a move when completion persistence fails', async () => {
    const f = await moveFixture(); const original = f.memory.port.save; let writes = 0;
    f.memory.port.save = async data => { writes++; if (writes === 2) throw Error('disk'); await original(data); };
    const plan = await f.service.prepare(f.path(), f.catalog.snapshot().targets[0]!.id); expect((await f.service.confirm(plan.id)).status).toBe('review');
    expect(f.path()).toBe(plan.destination); expect((await f.service.confirm(plan.id)).status).toBe('stale'); await f.service.recover(); expect(f.host.rename).toHaveBeenCalledTimes(1);
  });
});
