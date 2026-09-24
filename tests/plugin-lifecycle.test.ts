// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import NoteOrganizerPlugin from '../src/main';

const host = vi.hoisted(() => ({ initialize: vi.fn<() => Promise<void>>(), dispose: vi.fn(), registerView: vi.fn(), notice: vi.fn() }));
vi.mock('obsidian', () => ({
  getLanguage: () => 'en', setIcon: vi.fn(), Notice: class { constructor(message: string) { host.notice(message); } },
  Plugin: class { constructor(readonly app: App) {} registerView = host.registerView; },
}));
vi.mock('../src/obsidian/controller', () => ({ ObsidianOrganizer: class { initialize = host.initialize; dispose = host.dispose; } }));
vi.mock('../src/ui/review-view', () => ({ REVIEW_VIEW: 'note-organizer-inbox', LEGACY_REVIEW_VIEW: 'note-organizer-review', OrganizerReviewView: class {} }));
vi.mock('../src/ui/settings-tab', () => ({ OrganizerSettingsTab: class {} }));
vi.mock('../src/ui/link-modal', () => ({ LinkSuggestionsModal: class {} }));
vi.mock('../src/ui/filing-banner', () => ({ filingBanner: vi.fn() }));
vi.mock('../src/ui/target-picker', () => ({ DestinationPicker: class {} }));

beforeEach(() => vi.clearAllMocks());
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(viewType = 'empty') {
  const leaf = { view: { getViewType: () => viewType }, setViewState: vi.fn(async (_state: { type: string }): Promise<void> => undefined) };
  const workspace = { getLeavesOfType: () => [leaf], revealLeaf: vi.fn(async () => undefined) };
  const plugin = new NoteOrganizerPlugin({ workspace } as unknown as App, {} as PluginManifest);
  return { plugin, leaf, workspace };
}

it('does not register a plugin whose asynchronous initialization finishes after unload', async () => {
  const pending = deferred(); host.initialize.mockReturnValue(pending.promise);
  const { plugin } = fixture(), loading = plugin.onload(); plugin.onunload();
  expect(host.dispose).toHaveBeenCalled(); pending.resolve(); await loading;
  expect(host.registerView).not.toHaveBeenCalled(); expect(host.notice).not.toHaveBeenCalled();
});

it('does not recreate a retained view if unloading happens while clearing its old instance', async () => {
  const pending = deferred(), { plugin, leaf, workspace } = fixture('note-organizer-inbox');
  const access = plugin as unknown as { organizer: { dispose(): void }; openReview(): Promise<void> };
  access.organizer = { dispose: host.dispose }; leaf.setViewState.mockImplementationOnce(() => pending.promise);
  const opening = access.openReview(); expect(leaf.setViewState).toHaveBeenCalledExactlyOnceWith({ type: 'empty' });
  plugin.onunload(); pending.resolve(); await opening;
  expect(leaf.setViewState).toHaveBeenCalledTimes(1); expect(workspace.revealLeaf).not.toHaveBeenCalled();
});

it('does not reveal an asynchronously opened view after the plugin unloads', async () => {
  const pending = deferred(), { plugin, leaf, workspace } = fixture();
  const access = plugin as unknown as { organizer: { dispose(): void }; openReview(): Promise<void> };
  access.organizer = { dispose: host.dispose }; leaf.setViewState.mockImplementationOnce(() => pending.promise);
  const opening = access.openReview(); plugin.onunload(); pending.resolve(); await opening;
  expect(leaf.setViewState).toHaveBeenCalledExactlyOnceWith({ type: 'note-organizer-inbox' }); expect(workspace.revealLeaf).not.toHaveBeenCalled();
});
