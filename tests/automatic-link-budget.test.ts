import { afterEach, expect, it, vi } from 'vitest';
import { PluginStateStore } from '../src/storage/state-store';
import { SharedDecisionScheduler } from '../src/jev/scheduler';
import { OrganizerError } from '../src/core/errors';
import { estimateFilingRequests } from '../src/obsidian/analysis-estimate';
import { DEFAULT_SETTINGS } from '../src/settings';
import { answer, batch, memoryPort, scope } from './helpers';

afterEach(() => vi.useRealTimers());
it('migrates legacy usage and limits only automatic linking across restarts', async () => {
  const memory = memoryPort(); memory.local.set('note-organizer-usage', { day: '2026-09-24', requests: 1, unknownRequests: 0, inputTokens: 4 });
  const store = new PluginStateStore(memory.port, () => new Date(2026, 8, 24)); await store.load();
  await store.usage.reserve(10, { automaticLinkLimit: 1 }); await store.usage.settle(2);
  const restarted = new PluginStateStore(memory.port, () => new Date(2026, 8, 24)); await restarted.load();
  await expect(restarted.usage.reserve(10, { automaticLinkLimit: 1 })).rejects.toMatchObject({ code: 'budget' });
  await restarted.usage.reserve(10); expect(restarted.usage.read()).toMatchObject({ requests: 3, automaticLinkRequests: 1 });
});
it('counts retries toward automatic link allowance without pausing filing', async () => {
  vi.useFakeTimers(); const store = new PluginStateStore(memoryPort().port); await store.load();
  const evaluate = vi.fn().mockRejectedValueOnce(new OrganizerError('network', 'retry')).mockResolvedValue(answer(batch));
  const scheduler = new SharedDecisionScheduler({ evaluate }, store.usage, () => 4, { minAutomaticIntervalMs: 0 });
  const result = scheduler.evaluate(batch, { ...scope('link', true), priority: 'link' }).catch(error => error as OrganizerError);
  await vi.advanceTimersByTimeAsync(1100); expect(await result).toMatchObject({ code: 'budget' }); expect(evaluate).toHaveBeenCalledTimes(1); expect(scheduler.status().paused).toBe(false);
  await expect(scheduler.evaluate(batch, scope('filing', true))).resolves.toMatchObject({ modelId: batch.modelId }); expect(evaluate).toHaveBeenCalledTimes(2); scheduler.dispose();
});
it('adds new settings defaults to old schema without accepting malformed legacy fields', async () => {
  const settings = { ...DEFAULT_SETTINGS } as Record<string, unknown>; for (const key of ['provider', 'endpoint', 'longNoteStrategy', 'folderProfilesEnabled']) delete settings[key];
  const memory = memoryPort({ schemaVersion: 1, settings, filingQueue: [], moveJournal: [] });
  const store = new PluginStateStore(memory.port); await store.load(); expect(store.snapshot().settings.provider).toBe('jev'); expect(memory.port.save).not.toHaveBeenCalled();
  settings.inbox = 123; const invalid = memoryPort({ schemaVersion: 2, settings, filingQueue: [], moveJournal: [] });
  const broken = new PluginStateStore(invalid.port); await expect(broken.load()).rejects.toThrow(); await expect(broken.updateQueue([])).rejects.toThrow(); expect(invalid.port.save).not.toHaveBeenCalled();
});

it('estimates ordinary small and grouped folder catalogues without multiplying retries', () => {
  const folders = Array.from({ length: 384 }, (_, i) => ({ id: 'f' + i, path: 'Resources/Topic ' + i, directPurpose: '', effectiveRules: [] }));
  expect(estimateFilingRequests(folders.slice(0, 20), 12000)).toEqual({ min: 1, max: 1 });
  expect(estimateFilingRequests(folders, 12000)).toEqual({ min: 3, max: 3 });
});
