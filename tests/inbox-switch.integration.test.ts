// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MarkdownFileInfo, Plugin as ObsidianPlugin } from 'obsidian';
import { ObsidianOrganizer } from '../src/obsidian/controller';
import { filingPills } from '../src/ui/filing-pill';
import { DEFAULT_SETTINGS } from '../src/settings';
import { setLocale } from '../src/i18n';
import { FakeApp, Plugin, requestUrl, TFile, TFolder } from './fakes/obsidian';
import { deferred } from './helpers';

const cleanup: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers(); requestUrl.mockReset(); setLocale('en'); });
afterEach(() => { for (const close of cleanup.splice(0)) close(); document.body.replaceChildren(); vi.useRealTimers(); });
function response(body: string) {
  const request = JSON.parse(body) as { model: string; state: { note: { body: string } }; questions: Record<string, { criteria: Record<string, unknown> }> };
  const folder = request.state.note.body.includes('PROJECT') ? 'Projects' : 'Reading';
  return { status: 200, headers: {}, json: { model: request.model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const ids = Object.keys(question.criteria), choice = ids.find(key => JSON.stringify(question.criteria[key]).includes(folder))!;
    return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(ids.map(key => [key, key === choice ? 1 : 0])) }];
  })) } };
}
async function fixture() {
  const app = new FakeApp();
  for (const path of ['Inbox', 'Reading', 'Projects']) app.files.set(path, new TFolder(path));
  const first = app.add('Inbox/First.md', 'READING a book'), second = app.add('Inbox/Second.md', 'PROJECT a garden');
  let current = first, editorText = first.body;
  const info = { file: first, editor: { getValue: () => editorText } };
  app.workspace.activeEditor = info as unknown as MarkdownFileInfo;
  const plugin = new Plugin(app); plugin.data = { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS, inbox: 'Inbox', secretName: 'key' }, filingQueue: [], moveJournal: [] };
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin); await controller.initialize(); controller.setEnabled(true);
  const parent = document.body.appendChild(document.createElement('div'));
  const pills = filingPills(controller, { chooseDestination: () => undefined, menu: () => undefined });
  const detach = pills.attach({ parent, file: () => current, hasFocus: () => true, focusNote: () => undefined, openNote: () => undefined });
  cleanup.push(() => { detach(); void controller.dispose(); plugin.unload(); });
  requestUrl.mockImplementation(async ({ body }: { body: string }) => response(body));
  return { app, controller, first, second, pill: () => parent.querySelector<HTMLElement>('.note-organizer-pill-host')!,
    show: (file: TFile, text = file.body) => { current = file; info.file = file; editorText = text; app.workspace.emit('file-open', file); pills.refresh(); },
  };
}
it('classifies the opened file rather than the previous editor body and restores each note’s own result', async () => {
  const f = await fixture(); expect(requestUrl).not.toHaveBeenCalled();
  f.show(f.first); await vi.waitFor(() => expect(f.pill().textContent).toBe('→ Reading'));
  // The view file changes before its asynchronous body load completes.
  f.show(f.second, f.first.body);
  await vi.waitFor(() => expect(f.pill().textContent).toBe('→ Projects'));
  const sent = requestUrl.mock.calls.map(([request]) => (JSON.parse(request.body as string) as { state: { note: { title: string; body: string } } }).state.note);
  expect(sent).toEqual([{ title: 'First', body: f.first.body, tags: [] }, { title: 'Second', body: f.second.body, tags: [] }]);
  f.show(f.first); expect(f.pill().textContent).toBe('→ Reading');
  f.show(f.second); expect(f.pill().textContent).toBe('→ Projects');
  expect(requestUrl).toHaveBeenCalledTimes(2);
});
it('shows preparation while another note is running and does not restart queued analysis on repeated opens', async () => {
  const f = await fixture(), firstReply = deferred<void>();
  requestUrl.mockImplementationOnce(async ({ body }: { body: string }) => { await firstReply.promise; return response(body); });
  f.show(f.first); await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));
  f.show(f.second); f.show(f.second);
  expect(f.pill().textContent).toBe('Preparing…'); expect(requestUrl).toHaveBeenCalledTimes(1);
  firstReply.resolve(); await vi.waitFor(() => expect(f.pill().textContent).toBe('→ Projects'));
  expect(requestUrl).toHaveBeenCalledTimes(2);
});
it('can analyze on reopening after a queued attempt was cancelled before it sent anything', async () => {
  const f = await fixture(); f.show(f.first);
  f.controller.setEnabled(false); f.controller.setEnabled(true); f.show(f.first);
  await vi.waitFor(() => expect(f.pill().textContent).toBe('→ Reading'));
  expect(requestUrl).toHaveBeenCalledTimes(1);
});
it('still includes unsaved editor content for explicit manual analysis', async () => {
  const f = await fixture(); await f.controller.saveSettings({ analyzeOnOpen: false });
  f.show(f.first, 'PROJECT unsaved work'); f.controller.analyzeNote(f.first.path);
  await vi.waitFor(() => expect(f.pill().textContent).toBe('→ Projects'));
  expect(requestUrl.mock.calls[0]![0].body).toContain('PROJECT unsaved work');
});
