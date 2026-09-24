// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import NoteOrganizerPlugin from '../src/main';

const host = vi.hoisted(() => ({ initialize: vi.fn<() => Promise<void>>(), dispose: vi.fn(), registerView: vi.fn(), notice: vi.fn() }));
vi.mock('obsidian', () => ({
  getLanguage: () => 'en', setIcon: vi.fn(), MarkdownView: class {}, Menu: class {}, ItemView: class {}, editorInfoField: {}, Notice: class { constructor(message: string) { host.notice(message); } },
  Plugin: class { constructor(readonly app: App) {} registerView = host.registerView; },
}));
vi.mock('../src/obsidian/controller', () => ({ ObsidianOrganizer: class { initialize = host.initialize; dispose = host.dispose; subscribe = () => () => undefined; enabled = () => true; state = () => ({ filing: [], links: [], activePath: null, network: { reason: null } }); } }));
vi.mock('../src/ui/settings-tab', () => ({ OrganizerSettingsTab: class {} }));
vi.mock('../src/ui/link-modal', () => ({ LinkSuggestionsModal: class {} }));
vi.mock('../src/ui/analysis-modal', () => ({ AnalysisModal: class {} }));
vi.mock('../src/ui/inbox-modal', () => ({ InboxModal: class {} }));
vi.mock('../src/ui/filing-pill', () => ({ filingPills: vi.fn(() => ({ extension: [], open: () => false })) }));
vi.mock('../src/ui/link-hints', () => ({ linkHints: vi.fn(() => ({ extension: [], acceptAtCursor: () => false })) }));
vi.mock('../src/ui/target-picker', () => ({ DestinationPicker: class {}, TargetPicker: class {} }));
vi.mock('../src/obsidian/explorer-integration', () => ({ registerExplorerIntegration: vi.fn() }));

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

it('closes organizer tabs restored from earlier versions once the layout is ready', async () => {
  host.initialize.mockResolvedValue(undefined);
  const retired = [{ detach: vi.fn() }, { detach: vi.fn() }];
  const workspace = { getLeavesOfType: vi.fn((type: string) => type === 'note-organizer-inbox' ? [retired[0]] : type === 'note-organizer-review' ? [retired[1]] : []), onLayoutReady: (ready: () => void) => ready() };
  const plugin = new NoteOrganizerPlugin({ workspace } as unknown as App, {} as PluginManifest);
  Object.assign(plugin, {
    registerView: host.registerView, addSettingTab: vi.fn(), registerEditorExtension: vi.fn(), register: vi.fn(), registerDomEvent: vi.fn(), addCommand: vi.fn(),
    addStatusBarItem: () => { const element = document.createElement('div'); return Object.assign(element, { createEl: (tag: string) => Object.assign(element.appendChild(document.createElement(tag)), { createSpan: () => element.appendChild(document.createElement('span')) }) }); },
  });
  await plugin.onload();
  expect(host.registerView.mock.calls.map(call => call[0])).toEqual(['note-organizer-inbox', 'note-organizer-review']);
  expect(retired.every(leaf => leaf.detach.mock.calls.length === 1)).toBe(true);
  plugin.onunload();
});
