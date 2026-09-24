// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { App, Plugin as RealPlugin } from 'obsidian';
import { ObsidianOrganizer } from '../src/obsidian/controller';
import { InboxModal } from '../src/ui/inbox-modal';
import { FakeApp, Plugin, requestUrl, TFolder } from './fakes/obsidian';
import { DEFAULT_SETTINGS } from '../src/settings';
import { setLocale } from '../src/i18n';

it('keeps an edited pending note in the inbox instead of using its obsolete destination', async () => {
  vi.useFakeTimers(); setLocale('en');
  const app = new FakeApp(); for (const path of ['Inbox', 'Resources']) app.files.set(path, new TFolder(path));
  const first = app.add('Inbox/A.md', 'Original A'), second = app.add('Inbox/B.md', 'Original B');
  const plugin = new Plugin(app); plugin.data = { schemaVersion: 1, settings: { ...DEFAULT_SETTINGS, inbox: 'Inbox', secretName: 'key' }, filingQueue: [], moveJournal: [] };
  const controller = new ObsidianOrganizer(plugin as unknown as RealPlugin); await controller.initialize();
  requestUrl.mockImplementation(async ({ body }: { body: string }) => { const request = JSON.parse(body); return { status: 200, headers: {}, json: { model: request.model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => { const ids = Object.keys((q as { criteria: object }).criteria); return [id, { type: 'choice', choice: ids[0], confidence: 1, probabilities: Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 1 : 0])) }]; })) } }; });
  controller.analyzeNote(first.path); controller.analyzeNote(second.path);
  await vi.waitFor(() => expect(controller.state().filing.filter(entry => entry.status === 'ready')).toHaveLength(2));
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const original = controller.confirmMove.bind(controller);
  const confirm = vi.spyOn(controller, 'confirmMove').mockImplementationOnce(async plan => { await barrier; return original(plan); });
  const modal = new InboxModal({} as App, controller, { chooseDestination() {}, openNote() {}, analyze() {} }); modal.open();
  [...modal.contentEl.querySelectorAll('button')].find(button => button.textContent === 'File 2 notes')!.click();
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  const pending = confirm.mock.calls[0]![0].source.path === first.path ? second : first;
  const oldPath = pending.path; pending.body = 'Completely changed note'; app.vault.emit('modify', pending);
  expect(controller.state().filing.find(entry => entry.path === oldPath)?.proposal).toBeUndefined();
  release(); await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('Filed 1 of 2 notes.'));
  expect(app.fileManager.renameFile).toHaveBeenCalledTimes(1);
  expect(pending.path).toBe(oldPath);
  expect(modal.contentEl.querySelector('.note-organizer-feedback')).not.toBeNull();
  expect(pending.body).toBe('Completely changed note');
  modal.close(); controller.dispose(); plugin.unload(); vi.useRealTimers();
});
