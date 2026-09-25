// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { App, Plugin as ObsidianPlugin } from 'obsidian';
import { renderSettings } from '../src/ui/settings-tab';
import { ObsidianOrganizer } from '../src/obsidian/controller';
import { DEFAULT_SETTINGS } from '../src/settings';
import { FakeApp, Plugin, requestUrl, Setting, TFolder } from './fakes/obsidian';

import { setLocale, t } from '../src/i18n';
beforeEach(() => setLocale('zh'));
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); });

async function settingsFixture(inbox = 'Inbox') {
  const app = new FakeApp();
  for (const path of ['Inbox', 'Reading', 'Research']) app.files.set(path, new TFolder(path));
  const plugin = new Plugin(app);
  plugin.data = { schemaVersion: 1, settings: { ...DEFAULT_SETTINGS, inbox, secretName: 'key' }, filingQueue: [], moveJournal: [] };
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin);
  await controller.initialize();
  disposals.push(() => { controller.dispose(); plugin.unload(); });
  const container = document.body.appendChild(document.createElement('div'));
  renderSettings(container, app as unknown as App, controller);
  return { app, plugin, controller, container };
}
function choose(container: HTMLElement, folder: string): void {
  [...container.querySelectorAll('button')].find(button => button.textContent === '选择目录')!.click();
  const dialog = document.querySelector('[role="dialog"]')!;
  [...dialog.querySelectorAll('button')].find(button => button.textContent === folder)!.click();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
}
function watchAssimilation() {
  const original = Setting.prototype.then;
  let calls = 0;
  // Bound a regression's real recursive resolution so it fails instead of hanging the test runner.
  return vi.spyOn(Setting.prototype, 'then').mockImplementation(function (this: Setting, callback) {
    if (++calls > 8) throw new Error('Setting was returned to a Promise');
    return original.call(this, callback);
  });
}

describe('native settings selection integration', () => {
  it('saves directory choices without assimilating Obsidian Setting as a Promise', async () => {
    const f = await settingsFixture(), fluentThen = watchAssimilation();
    for (const folder of ['Reading', 'Research']) {
      choose(f.container, folder);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      await f.controller.store.flush();
      await vi.waitFor(() => expect(f.controller.settings()).toMatchObject({ inbox: folder, secretName: 'key' }));
      expect(f.plugin.data).toMatchObject({ settings: { inbox: folder, secretName: 'key' } });
      expect(f.container.textContent).toContain(folder);
    }
    expect(fluentThen).not.toHaveBeenCalled();
    expect(f.app.vault.read).not.toHaveBeenCalled();
    expect(requestUrl).not.toHaveBeenCalled();
  });
  it('keeps the previous directory when saving fails and accepts a later retry', async () => {
    const f = await settingsFixture(), fluentThen = watchAssimilation();
    await f.controller.store.flush();
    f.plugin.saveData.mockRejectedValueOnce(new Error('write failed'));
    choose(f.container, 'Reading');
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(f.controller.settings().inbox).toBe('Inbox');
    await vi.waitFor(() => expect(f.container.querySelector('[role="status"]')?.textContent).toContain('存储'));
    choose(f.container, 'Reading');
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await f.controller.store.flush();
    await vi.waitFor(() => expect(f.controller.settings().inbox).toBe('Reading'));
    expect(f.container.querySelector('[role="status"]')?.textContent).toBe('');
    expect(fluentThen).not.toHaveBeenCalled();
  });
});

it('clears the old key and applies endpoint/model together when switching providers', async () => {
  const f = await settingsFixture();
  const select = f.container.querySelector('select')!; select.value = 'anthropic'; select.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(f.controller.settings()).toMatchObject({ provider: 'anthropic', secretName: '', endpoint: 'https://api.anthropic.com/v1', modelId: 'claude-sonnet-4-6' }));
  expect(requestUrl).not.toHaveBeenCalled();
});

it('offers OpenRouter with its endpoint and model, clears the old key and saves a custom model', async () => {
  const f = await settingsFixture(); requestUrl.mockClear();
  const select = f.container.querySelector('select')!;
  expect([...select.options].find(option => option.value === 'openrouter')?.textContent).toBe('OpenRouter');
  select.value = 'openrouter'; select.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(f.controller.settings()).toMatchObject({ provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', modelId: 'openai/gpt-4.1-mini', secretName: '' }));
  await vi.waitFor(() => expect(f.container.textContent).toContain(t('settings.openrouterModelHelp')));
  const model = [...f.container.querySelectorAll('input')].find(input => input.value === 'openai/gpt-4.1-mini')!;
  model.value = 'vendor/custom-model'; model.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(f.plugin.data).toMatchObject({ settings: { provider: 'openrouter', modelId: 'vendor/custom-model', secretName: '' } }));
  expect(requestUrl).not.toHaveBeenCalled();
});

it('waits for a pending connection setting before sending the connection test', async () => {
  const f = await settingsFixture();
  requestUrl.mockResolvedValue({ status: 200, headers: {}, json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: { connection: { choice: 'learning', ranking: ['learning', 'none'] } } }) } }] } });
  const save = f.controller.saveSettings({ provider: 'openai-compatible', endpoint: 'http://localhost:19436/v1', modelId: 'test-model', secretName: '' });
  await f.controller.testConnection(); await save;
  expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://localhost:19436/v1/chat/completions' }));
});

it('starts with connection essentials and keeps native advanced headings inside a closed section', async () => {
  setLocale('en');
  const f = await settingsFixture('');
  const options = f.container.querySelector('details')!;
  expect(options.open).toBe(false);
  expect(options.querySelector('summary')?.textContent).toBe('More settings');
  expect(f.container.querySelectorAll('.setting-item-heading')).toHaveLength(6);
  expect(options.querySelectorAll('.setting-item-heading')).toHaveLength(5);
  expect(f.container.textContent).not.toMatch(/\p{Script=Han}/u);
  expect([...f.container.querySelectorAll('input, select, button')].filter(element => !element.closest('details')).length).toBeGreaterThan(0);
});

it('opens advanced settings after a successful first connection', async () => {
  setLocale('en');
  const f = await settingsFixture('');
  await f.controller.saveSettings({ inbox: 'Inbox', provider: 'openai-compatible', endpoint: 'http://localhost:19436/v1', modelId: 'test-model', secretName: '' });
  requestUrl.mockResolvedValue({ status: 200, headers: {}, json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: { connection: { choice: 'learning', ranking: ['learning', 'none'] } } }) } }] } });
  [...f.container.querySelectorAll('button')].find(button => button.textContent === t(f.controller.enabled() ? 'settings.check' : 'settings.enable'))!.click();
  await vi.waitFor(() => expect(f.container.querySelector('details')?.open).toBe(true));
});
