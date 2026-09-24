// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Plugin as ObsidianPlugin } from 'obsidian';
import { Emitter } from '../src/core/events';
import { DEFAULT_SETTINGS } from '../src/settings';
import { setLocale } from '../src/i18n';
import { registerExplorerIntegration } from '../src/obsidian/explorer-integration';
import type { FilingEntry, MovePlan } from '../src/filing/types';
import type { OrganizerController } from '../src/ui/types';
import { FakeApp, Plugin, TFile, TFolder, notices } from './fakes/obsidian';
import { context } from './helpers';

interface Item { title: string; run?: () => void }
function menu() {
  const items: Item[] = [];
  const addItem = (build: (item: unknown) => void) => {
    const item: Item = { title: '' };
    const api = { setTitle: (title: string) => { item.title = title; return api; }, setIcon: () => api, setSection: () => api, onClick: (run: () => void) => { item.run = run; return api; } };
    build(api); items.push(item);
  };
  return { items, addItem, titles: () => items.map(item => item.title), click: (title: string) => items.find(item => item.title === title)!.run!() };
}
beforeEach(() => {
  setLocale('en'); vi.useFakeTimers(); notices.length = 0;
  vi.stubGlobal('createFragment', (build: (fragment: DocumentFragment) => void) => {
    const fragment = Object.assign(document.createDocumentFragment(), {
      appendText(text: string) { fragment.append(text); },
      createEl(tag: string, options: { text: string }) { const element = document.createElement(tag); element.textContent = options.text; fragment.append(element); return element; },
    });
    build(fragment); return fragment;
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture(options: { navigatorVersion?: string; markers?: boolean; deferLayout?: boolean } = {}) {
  const app = new FakeApp(), changes = new Emitter();
  const explorer = { view: { containerEl: document.createElement('div'), fileItems: {} as Record<string, { selfEl: HTMLElement }> } };
  for (const path of ['Inbox', 'Inbox/Ready.md', 'Inbox/Raw.md']) explorer.view.fileItems[path] = { selfEl: explorer.view.containerEl.appendChild(document.createElement('div')) };
  const layoutReady: (() => void)[] = [];
  if (options.deferLayout) app.workspace.onLayoutReady = callback => { layoutReady.push(callback); };
  const navigator = { disposeFile: vi.fn(), disposeFolder: vi.fn(), file: undefined as undefined | ((context: unknown) => void), folder: undefined as undefined | ((context: unknown) => void) };
  Object.assign(app.workspace, { getLeavesOfType: (type: string) => type === 'file-explorer' ? [explorer] : [] });
  if (options.navigatorVersion) Object.assign(app, { plugins: { plugins: { 'notebook-navigator': { api: { getVersion: () => options.navigatorVersion, menus: { registerFileMenu: (callback: (context: unknown) => void) => { navigator.file = callback; return navigator.disposeFile; }, registerFolderMenu: (callback: (context: unknown) => void) => { navigator.folder = callback; return navigator.disposeFolder; } } } } } } });
  const entries: FilingEntry[] = [
    { path: 'Inbox/Ready.md', status: 'ready', updatedAt: 1, message: null, proposal: { id: 'p', source: { noteId: 1, path: 'Inbox/Ready.md', revision: 1, contentHash: 'h' }, foldersRevision: 1, context, selected: 'reading', ranked: [{ targetId: 'reading', probability: .5 }, { targetId: 'projects', probability: .45 }] } },
    { path: 'Inbox/Raw.md', status: 'waiting', updatedAt: 1, message: null },
  ];
  const settings = { ...DEFAULT_SETTINGS, inbox: 'Inbox', explorerMarkers: options.markers ?? true };
  const controller = {
    subscribe: (listener: () => void) => changes.subscribe(listener), settings: () => settings, state: () => ({ filing: entries }),
    folders: () => [{ id: 'reading', path: 'Resources/Reading', directPurpose: '', effectiveRules: [] }, { id: 'projects', path: 'Projects', directPurpose: '', effectiveRules: [] }],
    prepareMove: vi.fn(async (path: string, folderId: string): Promise<MovePlan> => ({ id: 'plan', source: { noteId: 1, path, revision: 1, contentHash: 'h' }, destination: 'Resources/Reading/Ready.md', folderId, foldersRevision: 1, settingsRevision: 1 })),
    confirmMove: vi.fn(async () => undefined), undoMove: vi.fn(async () => undefined), analyzeNote: vi.fn(), ignoreNote: vi.fn(),
  };
  const actions = { eligible: (path: string) => path.startsWith('Inbox/'), organize: vi.fn(), analyze: vi.fn(), chooseDestination: vi.fn<(choose: (id: string) => void) => void>() };
  const plugin = new Plugin(app);
  registerExplorerIntegration(plugin as unknown as ObsidianPlugin, controller as unknown as OrganizerController, actions);
  const nativeMenu = (file: TFile | TFolder) => { const value = menu(); app.workspace.emit('file-menu', value, file); return value; };
  return { app, controller, actions, plugin, explorer, navigator, nativeMenu, settings, layoutReady, emit: () => changes.emit() };
}

it('adds filing actions to the native file menu only for inbox notes and files the displayed destination', async () => {
  const f = fixture();
  const ready = f.nativeMenu(new TFile('Inbox/Ready.md'));
  expect(ready.titles()).toEqual(['File to Resources › Reading', 'File to Projects', 'File to another folder…', 'Stop suggesting this note']);
  expect(f.nativeMenu(new TFile('Resources/Other.md')).titles()).toEqual([]);
  expect(f.nativeMenu(new TFile('Inbox/Raw.md')).titles()[0]).toBe('Analyze for filing');
  ready.click('File to Resources › Reading'); await vi.advanceTimersByTimeAsync(0);
  expect(f.controller.prepareMove).toHaveBeenCalledWith('Inbox/Ready.md', 'reading'); expect(f.controller.confirmMove).toHaveBeenCalledOnce();
  expect(notices.at(-1)).toContain('Filed to Resources › Reading');
});

it('offers inbox organizing on the folder and batch actions on multiple selection', () => {
  const f = fixture();
  const folder = f.nativeMenu(new TFolder('Inbox')); folder.click('Organize inbox…'); expect(f.actions.organize).toHaveBeenCalledWith();
  const many = menu(); f.app.workspace.emit('files-menu', many, [new TFile('Inbox/Ready.md'), new TFile('Inbox/Raw.md'), new TFile('Elsewhere.md')]);
  expect(many.titles()).toEqual(['File 1 notes…', 'Analyze 2 notes…']);
  many.click('File 1 notes…'); expect(f.actions.organize).toHaveBeenLastCalledWith(['Inbox/Ready.md', 'Inbox/Raw.md']);
});

it('registers the same menus with Notebook Navigator 1.2+ and skips older API versions', () => {
  const f = fixture({ navigatorVersion: '2.0.0' });
  const single = menu(); f.navigator.file!({ addItem: single.addItem, file: new TFile('Inbox/Ready.md'), selection: { mode: 'single', files: [] } });
  expect(single.titles()[0]).toBe('File to Resources › Reading');
  const many = menu(); f.navigator.file!({ addItem: many.addItem, file: new TFile('Inbox/Ready.md'), selection: { mode: 'multiple', files: [new TFile('Inbox/Ready.md'), new TFile('Inbox/Raw.md')] } });
  expect(many.titles()).toEqual(['File 1 notes…', 'Analyze 2 notes…']);
  const folder = menu(); f.navigator.folder!({ addItem: folder.addItem, folder: new TFolder('Inbox') }); expect(folder.titles()).toEqual(['Organize inbox…']);
  expect(fixture({ navigatorVersion: '1.1.0' }).navigator.file).toBeUndefined();
});

it('marks suggested notes and the inbox count in the built-in explorer and clears them when disabled', async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(200);
  const items = f.explorer.view.fileItems;
  expect(items['Inbox/Ready.md']!.selfEl.dataset.noteOrganizer).toBe('ready'); expect(items['Inbox/Raw.md']!.selfEl.dataset.noteOrganizer).toBeUndefined();
  expect(items['Inbox']!.selfEl.dataset.noteOrganizerCount).toBe('1');
  f.settings.explorerMarkers = false; f.emit(); await vi.advanceTimersByTimeAsync(200);
  expect(items['Inbox/Ready.md']!.selfEl.dataset.noteOrganizer).toBeUndefined(); expect(items['Inbox']!.selfEl.dataset.noteOrganizerCount).toBeUndefined();
  f.plugin.unload();
});

it('rebinds a replacement Navigator API once and disposes each registration once', () => {
  const f = fixture({ navigatorVersion: '2.0.0' });
  const initialFileMenu = f.navigator.file;
  f.app.workspace.emit('layout-change'); expect(f.navigator.file).toBe(initialFileMenu);
  const disposeFile = vi.fn(), disposeFolder = vi.fn();
  const replacement = { getVersion: () => '2.0.0', menus: { registerFileMenu: vi.fn(() => disposeFile), registerFolderMenu: vi.fn(() => disposeFolder) } };
  Object.assign(f.app, { plugins: { plugins: { 'notebook-navigator': { api: replacement } } } });
  f.app.workspace.emit('layout-change'); f.app.workspace.emit('layout-change');
  expect(f.navigator.disposeFile).toHaveBeenCalledOnce(); expect(f.navigator.disposeFolder).toHaveBeenCalledOnce();
  expect(replacement.menus.registerFileMenu).toHaveBeenCalledOnce(); expect(replacement.menus.registerFolderMenu).toHaveBeenCalledOnce();
  expect(disposeFile).not.toHaveBeenCalled(); expect(disposeFolder).not.toHaveBeenCalled();
  f.plugin.unload(); f.plugin.unload();
  expect(disposeFile).toHaveBeenCalledOnce(); expect(disposeFolder).toHaveBeenCalledOnce();
  expect(f.navigator.disposeFile).toHaveBeenCalledOnce(); expect(f.navigator.disposeFolder).toHaveBeenCalledOnce();
});

it('clears the old Navigator registrations when the API disappears and registers when it returns', () => {
  const f = fixture({ navigatorVersion: '2.0.0' });
  Object.assign(f.app, { plugins: { plugins: {} } }); f.app.workspace.emit('layout-change'); f.app.workspace.emit('layout-change');
  expect(f.navigator.disposeFile).toHaveBeenCalledOnce(); expect(f.navigator.disposeFolder).toHaveBeenCalledOnce();
  const dispose = vi.fn();
  const replacement = { getVersion: () => '2.0.0', menus: { registerFileMenu: vi.fn(() => dispose), registerFolderMenu: vi.fn(() => dispose) } };
  Object.assign(f.app, { plugins: { plugins: { 'notebook-navigator': { api: replacement } } } }); f.app.workspace.emit('layout-change');
  expect(replacement.menus.registerFileMenu).toHaveBeenCalledOnce(); expect(replacement.menus.registerFolderMenu).toHaveBeenCalledOnce();
  f.plugin.unload(); expect(dispose).toHaveBeenCalledTimes(2);
});

it('ignores layout-ready callbacks delivered after Organizer unload', () => {
  const f = fixture({ navigatorVersion: '2.0.0', deferLayout: true });
  expect(f.navigator.file).toBeUndefined(); expect(f.navigator.folder).toBeUndefined();
  f.plugin.unload();
  for (const ready of f.layoutReady) ready();
  f.app.workspace.emit('layout-change');
  expect(f.navigator.file).toBeUndefined(); expect(f.navigator.folder).toBeUndefined();
  expect(f.navigator.disposeFile).not.toHaveBeenCalled(); expect(f.navigator.disposeFolder).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
