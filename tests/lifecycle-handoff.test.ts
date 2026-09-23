import { afterEach, expect, it, vi } from 'vitest';
import type { Plugin as ObsidianPlugin } from 'obsidian';
import { ObsidianOrganizer } from '../src/obsidian/controller';
import { StableInboxQueue } from '../src/filing/inbox-queue';
import { SharedDecisionScheduler } from '../src/jev/scheduler';
import { PluginStateStore } from '../src/storage/state-store';
import { claimLifecycle } from '../src/obsidian/lifecycle';
import { DEFAULT_SETTINGS } from '../src/settings';
import { contentHash } from '../src/core/paths';
import { FakeApp, Plugin, TFolder, requestUrl } from './fakes/obsidian';
import { answer, batch, deferred, memoryPort, scope } from './helpers';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); vi.useRealTimers(); });
async function fixture() {
  const app = new FakeApp(); app.files.set('Inbox', new TFolder('Inbox')); app.files.set('Resources', new TFolder('Resources')); const file = app.add('Inbox/n.md', 'Synthetic note');
  const plugin = new Plugin(app); plugin.data = { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS, inbox: 'Inbox' }, filingQueue: [], moveJournal: [] };
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin); await controller.initialize();
  cleanup.push(async () => { plugin.unload(); await controller.dispose(); });
  return { app, plugin, controller, file };
}
function restart(f: Awaited<ReturnType<typeof fixture>>) {
  const plugin = new Plugin(f.app); plugin.loadData = vi.fn(async () => f.plugin.data); plugin.saveData = vi.fn(async data => { f.plugin.data = structuredClone(data); });
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin);
  cleanup.push(async () => { plugin.unload(); await controller.dispose(); });
  return { plugin, controller };
}

it('waits for the entire queued persistence chain before loading a new instance', async () => {
  const f = await fixture(); await f.controller.store.flush();
  const saving = deferred<void>(), started = deferred<void>(); const original = f.plugin.saveData;
  f.plugin.saveData = vi.fn(async value => { started.resolve(); await saving.promise; await original(value); });
  f.controller.ignoreNote(f.file.path); await started.promise;
  const closing = f.controller.dispose(); f.plugin.unload();
  const next = restart(f); const loading = next.controller.initialize(); await Promise.resolve();
  expect(next.plugin.loadData).not.toHaveBeenCalled(); saving.resolve(); await closing; await loading;
  expect(next.controller.state().filing[0]?.status).toBe('ignored');
  await next.controller.saveSettings({ dailyRequestLimit: 17 });
  expect((f.plugin.data as { settings: { dailyRequestLimit: number } }).settings.dailyRequestLimit).toBe(17);
  await expect(f.controller.saveSettings({ dailyRequestLimit: 100 })).rejects.toMatchObject({ code: 'cancelled' });
  next.controller.setEnabled(true); expect(() => f.controller.setEnabled(false)).toThrow(); expect(next.controller.enabled()).toBe(true);
});

it('drains accepted settings changes without losing earlier queued patches', async () => {
  const f = await fixture(); await f.controller.store.flush(); const saving = deferred<void>(), started = deferred<void>(); const original = f.plugin.saveData;
  f.plugin.saveData = vi.fn(async value => { started.resolve(); await saving.promise; await original(value); });
  const first = f.controller.saveSettings({ dailyRequestLimit: 17 }); const second = f.controller.saveSettings({ autoLinks: true }); await started.promise;
  const closing = f.controller.dispose(); const next = restart(f); const loading = next.controller.initialize();
  saving.resolve(); await Promise.all([first, second, closing, loading]);
  expect(next.controller.settings()).toMatchObject({ dailyRequestLimit: 17, autoLinks: true });
});

it('waits for confirmed moves to write completion before restoring and archiving history', async () => {
  const f = await fixture(); const moved = deferred<void>(), started = deferred<void>(); const rename = f.app.fileManager.renameFile;
  f.app.fileManager.renameFile = vi.fn(async (file, path) => { started.resolve(); await moved.promise; await rename(file, path); });
  const plan = await f.controller.prepareMove(f.file.path, f.controller.folders()[0]!.id); const moving = f.controller.confirmMove(plan); await started.promise;
  const closing = f.controller.dispose(); f.plugin.unload(); const next = restart(f); const loading = next.controller.initialize(); await Promise.resolve();
  expect(next.plugin.loadData).not.toHaveBeenCalled(); moved.resolve(); await Promise.all([moving, closing, loading]);
  expect(next.controller.recentMoves().find(record => record.id === plan.id)?.status).toBe('archived'); expect(f.file.path).toBe('Resources/n.md');
});

it('does not register events or extensions when unloaded during initialization', async () => {
  const app = new FakeApp(), plugin = new Plugin(app), loaded = deferred<unknown>(); plugin.loadData = () => loaded.promise;
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin);
  const result = controller.initialize().catch(error => error as Error); await Promise.resolve();
  const closing = controller.dispose(); loaded.resolve(null);
  expect(await result).toMatchObject({ code: 'cancelled' }); await closing;
  expect(plugin.extensions).toHaveLength(0); expect(plugin.callbacks).toHaveLength(0);
});

it('shares a host-scoped barrier across module reloads while keeping other Apps independent', async () => {
  const app = {}, first = claimLifecycle(app); vi.resetModules();
  const reloaded = await import('../src/obsidian/lifecycle'); const second = reloaded.claimLifecycle(app), other = reloaded.claimLifecycle({});
  let proceeded = false; void second.previous.then(() => { proceeded = true; }); await other.previous; expect(proceeded).toBe(false);
  first.release(); await second.previous; expect(proceeded).toBe(true); second.release(); other.release();
});

it('flushes saves already queued before disposal, including saves not yet submitted to the store', async () => {
  const saved = deferred<void>(); const persist = vi.fn(() => saved.promise);
  const queue = new StableInboxQueue({ eligible: () => true, automaticEnabled: () => false, isEditing: () => false, propose: async () => { throw Error('unexpected'); }, persist });
  await queue.restore([{ path: 'Inbox/n.md', status: 'pending' }]); queue.ignore('Inbox/n.md'); queue.dispose();
  let flushed = false; void queue.flush().then(() => { flushed = true; }); await Promise.resolve(); expect(persist).toHaveBeenCalledTimes(1); expect(flushed).toBe(false);
  saved.resolve(); await queue.flush(); expect(flushed).toBe(true);
});

it('retains unloaded HTTP usage as unknown and never overwrites newer usage when the response arrives', async () => {
  const memory = memoryPort(); const old = new PluginStateStore(memory.port); await old.load(); const response = deferred<ReturnType<typeof answer>>(), sent = deferred<void>();
  const scheduler = new SharedDecisionScheduler({ evaluate: () => { sent.resolve(); return response.promise; } }, old.usage, () => 10, { minAutomaticIntervalMs: 0 });
  const result = scheduler.evaluate(batch, scope()).catch(error => error as Error); await sent.promise; scheduler.dispose(); await old.flush();
  expect(await result).toMatchObject({ code: 'cancelled' });
  const next = new PluginStateStore(memory.port); await next.load(); await next.usage.reserve(10); await next.usage.settle(7);
  response.resolve(answer(batch)); await Promise.resolve(); await Promise.resolve(); await old.flush();
  expect(next.usage.read()).toMatchObject({ requests: 2, unknownRequests: 1, inputTokens: 7 });
  const persisted = new PluginStateStore(memory.port); await persisted.load(); expect(persisted.usage.read()).toEqual(next.usage.read());
});

it('does not send HTTP after disposal while a usage reservation is pending', async () => {
  const reserved = deferred<void>(), reserveStarted = deferred<void>(), evaluate = vi.fn(async () => answer(batch)), settle = vi.fn(async () => undefined);
  const scheduler = new SharedDecisionScheduler({ evaluate }, { read: () => ({ day: '2026-09-24', requests: 0, unknownRequests: 0, inputTokens: 0 }), reserve: () => { reserveStarted.resolve(); return reserved.promise; }, settle }, () => 10);
  const result = scheduler.evaluate(batch, scope()).catch(error => error as Error); await reserveStarted.promise; scheduler.dispose(); reserved.resolve();
  expect(await result).toMatchObject({ code: 'cancelled' }); await Promise.resolve(); expect(evaluate).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled();
});

it('allows a new controller to initialize before an old network request finishes', async () => {
  const f = await fixture(); await f.controller.saveSettings({ secretName: 'key' });
  const response = deferred<unknown>(), sent = deferred<void>(); requestUrl.mockImplementation(() => { sent.resolve(); return response.promise; });
  const request = f.controller.testConnection().catch(error => error as Error); await sent.promise;
  const closing = f.controller.dispose(); f.plugin.unload(); const next = restart(f); await next.controller.initialize(); await closing;
  expect(await request).toMatchObject({ code: 'cancelled' }); await next.controller.store.usage.reserve(100); await next.controller.store.usage.settle(7);
  response.resolve({ status: 200, headers: {}, json: { model: 'jev-1.13.0', usage: { input_tokens: 70 }, answers: { connection: { type: 'choice', choice: 'learning', confidence: 1, probabilities: { learning: 1, none: 0 } } } } });
  await Promise.resolve(); await Promise.resolve(); await f.controller.store.flush();
  expect(next.controller.usage()).toMatchObject({ requests: 2, inputTokens: 7, unknownRequests: 1 });
  expect(f.app.local.get('note-organizer-usage')).toEqual(next.controller.usage());
});

it('includes late recovery journal writes in the handoff without registering a disposed controller', async () => {
  const app = new FakeApp(); app.files.set('Inbox', new TFolder('Inbox')); app.files.set('Resources', new TFolder('Resources')); const file = app.add('Inbox/n.md', 'Synthetic');
  const plugin = new Plugin(app), source = deferred<string>(), reading = deferred<void>();
  plugin.data = { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS, inbox: 'Inbox' }, filingQueue: [], moveJournal: [{ id: 'old-intent', noteId: 8, from: file.path, to: 'Resources/n.md', contentHash: await contentHash(file.body), createdAt: 1, status: 'intent' }] };
  app.vault.read.mockImplementation(() => { reading.resolve(); return source.promise; });
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin); const result = controller.initialize().catch(error => error as Error); await reading.promise;
  const closing = controller.dispose(); const next = restart({ app, plugin, controller, file }); const loading = next.controller.initialize(); await Promise.resolve(); expect(next.plugin.loadData).not.toHaveBeenCalled();
  source.resolve(file.body); expect(await result).toMatchObject({ code: 'cancelled' }); await closing; await loading;
  expect(plugin.extensions).toHaveLength(0); expect(plugin.callbacks).toHaveLength(0); expect(next.controller.recentMoves()[0]?.status).toBe('archived');
});
