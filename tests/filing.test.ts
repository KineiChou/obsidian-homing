import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrganizerError } from '../src/core/errors';
import { MemoryFolderCatalog } from '../src/folders/catalog';
import { PluginStateStore } from '../src/storage/state-store';
import { StableInboxQueue } from '../src/filing/inbox-queue';
import { ConfirmedMoveService } from '../src/filing/move-service';
import { DEFAULT_SETTINGS, parseSettings } from '../src/settings';
import { inInbox, contentHash } from '../src/core/paths';
import type { FilingProposal, MoveHost, PersistedFilingProposal } from '../src/filing/types';
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
    currentPath: id => id === 10 ? path : null, exists: requested => requested === path || occupied.has(requested), eligible: requested => inInbox(requested, 'Inbox', true), referencesSafe: () => true, attachments: () => [], moveAttachment: vi.fn(async () => undefined),
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
    expect(f.path()).toBe(plan.destination); expect((await f.service.confirm(plan.id)).status).toBe('stale'); await f.service.recover(); expect(f.host.rename).toHaveBeenCalledTimes(1); expect(f.store.journal.records()[0]?.status).toBe('archived');
  });
});

const savedProposal = (): PersistedFilingProposal => ({ contentHash: note.source.contentHash, selectedPath: 'Resources', ranked: [{ path: 'Resources', probability: 1 }], modelId: context.modelId, promptRevision: context.promptRevision, settingsFingerprint: 'settings', createdAt: 1 });

describe('restorable suggestions', () => {
  it('migrates v1 in memory and degrades only malformed proposals without overwriting the source', async () => {
    const memory = memoryPort({ schemaVersion: 1, settings, moveJournal: [], filingQueue: [{ path: note.source.path, status: 'pending', proposal: { ...savedProposal(), ranked: [{ path: '../outside', probability: 1 }] } }] });
    const store = new PluginStateStore(memory.port); await store.load();
    expect(store.snapshot().schemaVersion).toBe(2); expect(store.snapshot().filingQueue[0]?.proposal).toBeUndefined(); expect(memory.port.save).not.toHaveBeenCalled();
    await store.updateQueue([{ path: note.source.path, status: 'pending', proposal: savedProposal() }]);
    const restarted = new PluginStateStore(memory.port); await restarted.load(); expect(restarted.snapshot().filingQueue[0]?.proposal).toEqual(savedProposal());
  });
  it('preserves a remapped suggestion and requeues invalid suggestions after stability delay', async () => {
    vi.useFakeTimers(); const propose = vi.fn(async () => proposal());
    const queue = new StableInboxQueue({ eligible: () => true, automaticEnabled: () => true, isEditing: () => false, propose, persist: async () => undefined, stableMs: 100 });
    queue.analyze(note.source.path); await vi.advanceTimersByTimeAsync(0);
    queue.invalidate(item => ({ ...item, foldersRevision: 2 })); await vi.advanceTimersByTimeAsync(1000);
    expect(queue.entries()[0]?.proposal?.foldersRevision).toBe(2); expect(propose).toHaveBeenCalledTimes(1);
    queue.invalidate(() => null); await vi.advanceTimersByTimeAsync(99); expect(propose).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(1); expect(propose).toHaveBeenCalledTimes(2); queue.dispose();
  });
  it('re-analyzes kept suggestions after a new folder, keeping each one until a new answer arrives', async () => {
    vi.useFakeTimers(); let automatic = true; const answer = deferred<FilingProposal>();
    const propose = vi.fn().mockResolvedValueOnce(proposal()).mockRejectedValueOnce(new OrganizerError('budget', 'error.budget')).mockReturnValueOnce(answer.promise);
    const queue = new StableInboxQueue({ eligible: () => true, automaticEnabled: () => automatic, isEditing: () => false, propose, persist: async () => undefined, stableMs: 100 });
    queue.analyze(note.source.path); await vi.advanceTimersByTimeAsync(0);
    const keep = (item: FilingProposal) => ({ ...item, foldersRevision: 2 });
    // A failed refresh (here: no budget left) keeps the current suggestion.
    queue.invalidate(keep, { reanalyze: true }); await vi.advanceTimersByTimeAsync(100);
    expect(propose).toHaveBeenCalledTimes(2); expect(queue.entries()[0]).toMatchObject({ status: 'ready', proposal: { selected: 'f1' }, message: null });
    // The new folder is renamed while its refresh runs: the refresh is scheduled again.
    queue.invalidate(keep, { reanalyze: true }); await vi.advanceTimersByTimeAsync(100); expect(propose).toHaveBeenCalledTimes(3);
    expect(queue.entries()[0]?.status).toBe('ready');
    queue.invalidate(keep); answer.resolve({ ...proposal(), selected: 'f2' }); await vi.advanceTimersByTimeAsync(0);
    expect(queue.entries()[0]?.proposal?.selected).toBe('f1');
    propose.mockResolvedValueOnce({ ...proposal(), selected: 'f2' }); await vi.advanceTimersByTimeAsync(100);
    expect(propose).toHaveBeenCalledTimes(4); expect(queue.entries()[0]).toMatchObject({ status: 'ready', proposal: { selected: 'f2' } });
    // Without automatic analysis a new folder never sends a request.
    automatic = false; queue.invalidate(keep, { reanalyze: true }); await vi.advanceTimersByTimeAsync(1000); expect(propose).toHaveBeenCalledTimes(4); queue.dispose();
  });
  it('restores offline but cannot overwrite a concurrent edit or removal', async () => {
    const restored = deferred<FilingProposal>(); const propose = vi.fn(async () => proposal());
    const queue = new StableInboxQueue({ eligible: () => true, automaticEnabled: () => true, isEditing: () => false, propose, persist: async () => undefined, restoreProposal: () => restored.promise });
    const loading = queue.restore([{ path: note.source.path, status: 'pending', proposal: savedProposal() }]);
    queue.remove(note.source.path); restored.resolve(proposal()); await loading;
    expect(queue.entries()).toEqual([]); expect(propose).not.toHaveBeenCalled(); queue.dispose();
  });
  it('persists minimal ready suggestions and restores them without scheduling analysis', async () => {
    vi.useFakeTimers(); const persist = vi.fn(async () => undefined); const propose = vi.fn(async () => proposal());
    const deps = { eligible: () => true, automaticEnabled: () => true, isEditing: () => false, propose, persist, encodeProposal: savedProposal, restoreProposal: async () => proposal() };
    const queue = new StableInboxQueue(deps); queue.analyze(note.source.path); await vi.advanceTimersByTimeAsync(0);
    expect(persist).toHaveBeenLastCalledWith([{ path: note.source.path, status: 'pending', proposal: savedProposal() }]); queue.dispose();
    const restarted = new StableInboxQueue(deps); await restarted.restore([{ path: note.source.path, status: 'pending', proposal: savedProposal() }]); await vi.advanceTimersByTimeAsync(60000);
    expect(restarted.entries()[0]?.status).toBe('ready'); expect(propose).toHaveBeenCalledTimes(1); restarted.dispose();
  });
  it('serializes queue submissions and leaves exhausted budget entries waiting', async () => {
    vi.useFakeTimers(); const first = deferred<FilingProposal>(); const propose = vi.fn().mockReturnValueOnce(first.promise).mockRejectedValue(new OrganizerError('budget', '今日额度已用完。'));
    const queue = new StableInboxQueue({ eligible: () => true, automaticEnabled: () => true, isEditing: () => false, propose, persist: async () => undefined });
    queue.analyze('Inbox/a.md'); queue.analyze('Inbox/b.md'); await vi.advanceTimersByTimeAsync(0); expect(propose).toHaveBeenCalledTimes(1);
    first.resolve(proposal()); await vi.advanceTimersByTimeAsync(1); expect(propose).toHaveBeenCalledTimes(2); expect(queue.entries().find(entry => entry.path.endsWith('b.md'))?.status).toBe('waiting'); queue.dispose();
  });
});

describe('durable move recovery', () => {
  it('archives successful history once, retains the bounded history, and never grants cross-session undo', async () => {
    const f = await moveFixture();
    for (let i = 0; i < 105; i++) await f.store.journal.put({ id: String(i), noteId: 10, from: note.source.path, to: 'Resources/n.md', contentHash: 'hash', createdAt: i, status: 'done' });
    expect((await f.service.undo('104')).status).toBe('stale'); await f.service.recover(); await f.service.recover();
    expect(f.store.journal.records()).toHaveLength(100); expect(f.store.journal.records().every(record => record.status === 'archived')).toBe(true); expect(f.host.rename).not.toHaveBeenCalled();
  });
  it('archives resolved intent, keeps ambiguous intent for review, and supports acknowledgement', async () => {
    const f = await moveFixture(); const source = await f.host.source(f.path());
    const record = { id: 'intent', noteId: 999, from: f.path(), to: 'Resources/n.md', contentHash: source!.contentHash, createdAt: 1, status: 'intent' as const };
    await f.store.journal.put(record); await f.service.recover(); expect(f.store.journal.records()[0]?.status).toBe('archived');
    await f.store.journal.put({ ...record, id: 'ambiguous', contentHash: 'different' }); await f.service.recover(); expect(f.store.journal.records().find(item => item.id === 'ambiguous')?.status).toBe('review');
    await f.service.acknowledge('ambiguous'); expect(f.store.journal.records().find(item => item.id === 'ambiguous')?.status).toBe('archived'); expect(f.host.rename).not.toHaveBeenCalled();
  });
});

it('returns the specific reference issue and never treats a warning string as approval', async () => {
  const f = await moveFixture(); f.host.referencesSafe = () => '现有链接会改指另一篇笔记。';
  await expect(f.service.prepare(f.path(), f.catalog.snapshot().targets[0]!.id)).rejects.toMatchObject({ code: 'unsafe', message: '现有链接会改指另一篇笔记。' });
  expect(f.host.rename).not.toHaveBeenCalled();
});

it('never trims unresolved history while enforcing the completed history bound', async () => {
  const f = await moveFixture();
  const record = { noteId: 1, from: 'Inbox/a.md', to: 'Resources/a.md', contentHash: 'hash', createdAt: 1 };
  await f.store.journal.put({ ...record, id: 'intent', status: 'intent' });
  await f.store.journal.put({ ...record, id: 'review', status: 'review' });
  for (let i = 0; i < 105; i++) await f.store.journal.put({ ...record, id: String(i), status: 'archived' });
  expect(f.store.journal.records()).toHaveLength(102);
  expect(f.store.journal.records().filter(item => item.status === 'intent' || item.status === 'review').map(item => item.id)).toEqual(['intent', 'review']);
});

it('keeps independently displayed banner and review plans until the source changes', async () => {
  const f = await moveFixture(), folder = f.catalog.snapshot().targets[0]!.id;
  const first = await f.service.prepare(f.path(), folder), second = await f.service.prepare(f.path(), folder);
  expect((await f.service.confirm(first.id)).status).toBe('done');
  expect((await f.service.confirm(second.id)).status).toBe('stale');
  expect(f.host.rename).toHaveBeenCalledTimes(1);
});
