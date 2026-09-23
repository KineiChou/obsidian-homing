import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plugin as ObsidianPlugin } from 'obsidian';
import { ObsidianOrganizer } from '../src/obsidian/controller';
import { FakeApp, Plugin, requestUrl, TFolder } from './fakes/obsidian';
import { DEFAULT_SETTINGS } from '../src/settings';
import { deferred } from './helpers';
const dispose: (() => void)[] = [];
afterEach(() => { for (const cleanup of dispose.splice(0)) cleanup(); vi.useRealTimers(); });
beforeEach(() => vi.clearAllMocks());
async function fixture(body = 'Reading notes') {
  const app = new FakeApp(); for (const name of ['Inbox', 'Resources', 'Private', 'Excluded']) app.files.set(name, new TFolder(name));
  const file = app.add('Inbox/Example.md', body);
  app.add('Inbox/InboxSecretMarker.md'); app.add('Resources/PublicProfileMarker.md'); app.add('Private/PrivateProfileMarker.md'); app.add('Excluded/ExcludedProfileMarker.md');
  const plugin = new Plugin(app); plugin.data = { schemaVersion: 1, settings: { ...DEFAULT_SETTINGS, inbox: 'Inbox', secretName: 'key', excludedPaths: ['Private'], excludedDestinations: ['Excluded'] }, filingQueue: [], moveJournal: [] };
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin); await controller.initialize();
  dispose.push(() => { controller.dispose(); plugin.unload(); });
  return { app, file, controller };
}
function response(body: string) {
  const batch = JSON.parse(body) as { model: string; questions: Record<string, { criteria: Record<string, unknown> }> };
  return { status: 200, headers: {}, json: { model: batch.model, answers: Object.fromEntries(Object.entries(batch.questions).map(([id, q]) => { const ids = Object.keys(q.criteria); return [id, { type: 'choice', choice: ids[0], confidence: 1, probabilities: Object.fromEntries(ids.map((key, i) => [key, i === 0 ? 1 : 0])) }]; })) } };
}
function mockResponses() { requestUrl.mockImplementation(async ({ body }: { body: string }) => response(body)); }
describe('decision host boundaries', () => {
  it('sends only opted-in destination metadata and respects inbox and both exclusions', async () => {
    vi.useFakeTimers(); const f = await fixture(); mockResponses();
    f.controller.analyzeNote(f.file.path); await vi.waitFor(() => expect(f.controller.state().filing.find(item => item.path === f.file.path)?.status).toBe('ready'));
    expect(requestUrl.mock.calls[0]?.[0].body).not.toContain('PublicProfileMarker');
    await f.controller.saveSettings({ folderProfilesEnabled: true }); f.controller.analyzeNote(f.file.path);
    await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(2));
    const sent = String(requestUrl.mock.calls[1]?.[0].body);
    expect(sent).toContain('PublicProfileMarker');
    for (const marker of ['InboxSecretMarker', 'PrivateProfileMarker', 'ExcludedProfileMarker']) expect(sent).not.toContain(marker);
    await f.controller.saveSettings({ folderProfilesEnabled: false }); f.controller.analyzeNote(f.file.path);
    await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(3)); expect(requestUrl.mock.calls[2]?.[0].body).not.toContain('PublicProfileMarker');
  });
  it('sends bounded Chinese excerpts through the host and rejects full input before transport', async () => {
    vi.useFakeTimers(); const f = await fixture('中文😀'.repeat(10000)); mockResponses();
    f.controller.analyzeNote(f.file.path); await vi.waitFor(() => expect(f.controller.state().filing.find(item => item.path === f.file.path)?.status).toBe('ready'));
    const sent = String(requestUrl.mock.calls[0]?.[0].body); expect(new TextEncoder().encode(sent).length).toBeLessThan(30000);
    expect(f.controller.state().filing.find(item => item.path === f.file.path)?.proposal?.excerpt?.originalChars).toBe(30000);
    await f.controller.saveSettings({ longNoteStrategy: 'full' }); f.controller.analyzeNote(f.file.path);
    await vi.waitFor(() => expect(f.controller.state().filing.find(item => item.path === f.file.path)?.message).toBe('error.questionBudget'));
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });
  it('cancels old credential requests immediately and ignores their later 401', async () => {
    vi.useFakeTimers(); const f = await fixture(); const pending = deferred<ReturnType<typeof response>>(); requestUrl.mockReturnValueOnce(pending.promise);
    const old = f.controller.testConnection().catch(error => error); await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));
    await f.controller.saveSettings({ secretName: 'replacement' }); expect(await old).toMatchObject({ code: 'cancelled' });
    pending.resolve({ status: 401, headers: {}, json: { model: 'unused', answers: {} } }); await vi.advanceTimersByTimeAsync(1);
    expect(f.controller.state().network.paused).toBe(false);
  });
  it('preserves ready proposals on credential changes but rejects an old connection success after provider changes', async () => {
    vi.useFakeTimers(); const f = await fixture(); mockResponses(); f.controller.analyzeNote(f.file.path);
    await vi.waitFor(() => expect(f.controller.state().filing.find(item => item.path === f.file.path)?.status).toBe('ready'));
    await f.controller.saveSettings({ secretName: 'replacement' }); expect(f.controller.state().filing.find(item => item.path === f.file.path)?.status).toBe('ready');
    await f.controller.saveSettings({ secretName: 'key' }); const pending = deferred<ReturnType<typeof response>>(); requestUrl.mockReturnValueOnce(pending.promise);
    const old = f.controller.testConnection().catch(error => error); await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(2));
    const oldBody = String(requestUrl.mock.calls[1]?.[0].body);
    await f.controller.saveSettings({ provider: 'openai-compatible', endpoint: 'http://localhost:11434/v1', modelId: 'local-model', secretName: '' });
    pending.resolve(response(oldBody)); expect(await old).toMatchObject({ code: 'cancelled' });
    expect(f.controller.state().filing.find(item => item.path === f.file.path)?.status).toBe('waiting');
  });
});
