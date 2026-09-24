import { Notice, TFile, TFolder, type MenuItem, type Plugin, type TAbstractFile } from 'obsidian';
import type { OrganizerController } from '../ui/types';
import { errorText, t } from '../i18n';

export interface ExplorerActions {
  eligible(path: string): boolean;
  organize(preselect?: readonly string[]): void;
  analyze(paths: readonly string[]): void;
  chooseDestination(choose: (id: string) => void): void;
}
type AddItem = (build: (item: MenuItem) => void) => void;
interface NavigatorApi {
  getVersion(): string;
  menus: {
    registerFileMenu(callback: (context: { addItem: AddItem; file: TFile; selection: { mode: 'single' | 'multiple'; files: readonly TFile[] } }) => void): () => void;
    registerFolderMenu(callback: (context: { addItem: AddItem; folder: TFolder }) => void): () => void;
  };
}
interface ExplorerItem { selfEl?: HTMLElement }

const breadcrumb = (path: string) => path.split('/').join(' › ');
const MARKER = 'noteOrganizer', COUNT = 'noteOrganizerCount';

/** Context menus for Obsidian's file explorer and Notebook Navigator, plus optional explorer markers. */
export function registerExplorerIntegration(plugin: Plugin, controller: OrganizerController, actions: ExplorerActions): void {
  const { app } = plugin;
  const fileNow = async (path: string, folderId: string) => {
    try {
      const plan = await controller.prepareMove(path, folderId);
      await controller.confirmMove(plan);
      const message = createFragment(fragment => {
        fragment.appendText(t('notice.filed', { path: breadcrumb(plan.destination.slice(0, plan.destination.lastIndexOf('/'))) }) + ' ');
        const undo = fragment.createEl('a', { text: t('organizer.undo'), href: '#' });
        undo.addEventListener('click', event => { event.preventDefault(); void controller.undoMove(plan.id).catch(error => new Notice(errorText(error))); });
      });
      new Notice(message, 6000);
    } catch (error) { new Notice(errorText(error)); }
  };
  const fileItems = (add: AddItem, file: TFile) => {
    if (file.extension !== 'md' || !actions.eligible(file.path)) return;
    const entry = controller.state().filing.find(item => item.path === file.path);
    if (entry?.status === 'ignored' || entry?.status === 'moving') return;
    const folders = controller.folders(), proposal = entry?.status === 'ready' ? entry.proposal : undefined;
    const selected = folders.find(folder => folder.id === proposal?.selected);
    if (selected) {
      add(item => item.setTitle(t('menu.fileTo', { path: breadcrumb(selected.path) })).setIcon('folder-input').setSection('note-organizer').onClick(() => { void fileNow(file.path, selected.id); }));
      const ranked = proposal!.ranked;
      if (ranked.length > 1 && ranked[0]!.probability - ranked[1]!.probability < .2) {
        for (const candidate of ranked.filter(item => item.targetId !== selected.id).slice(0, 2)) {
          const folder = folders.find(item => item.id === candidate.targetId);
          if (folder) add(item => item.setTitle(t('menu.fileTo', { path: breadcrumb(folder.path) })).setIcon('folder').setSection('note-organizer').onClick(() => { void fileNow(file.path, folder.id); }));
        }
      }
    } else if (entry?.status !== 'analyzing') add(item => item.setTitle(t('menu.analyze')).setIcon('sparkles').setSection('note-organizer').onClick(() => controller.analyzeNote(file.path)));
    // Choosing in the picker is the confirmation: the picker lists each full destination path.
    add(item => item.setTitle(t('menu.choose')).setIcon('folder-search').setSection('note-organizer').onClick(() => actions.chooseDestination(id => { void fileNow(file.path, id); })));
    add(item => item.setTitle(t('organizer.ignore')).setIcon('eye-off').setSection('note-organizer').onClick(() => controller.ignoreNote(file.path)));
  };
  const manyItems = (add: AddItem, files: readonly TAbstractFile[]) => {
    const paths = files.filter((file): file is TFile => file instanceof TFile && file.extension === 'md' && actions.eligible(file.path)).map(file => file.path);
    if (!paths.length) return;
    const ready = new Set(controller.state().filing.filter(entry => entry.status === 'ready').map(entry => entry.path));
    if (paths.some(path => ready.has(path))) add(item => item.setTitle(t('menu.fileMany', { count: paths.filter(path => ready.has(path)).length })).setIcon('folder-input').setSection('note-organizer').onClick(() => actions.organize(paths)));
    add(item => item.setTitle(t('menu.analyzeMany', { count: paths.length })).setIcon('sparkles').setSection('note-organizer').onClick(() => actions.analyze(paths)));
  };
  const folderItems = (add: AddItem, folder: TFolder) => {
    if (!controller.settings().inbox || folder.path !== controller.settings().inbox) return;
    add(item => item.setTitle(t('menu.organize')).setIcon('inbox').setSection('note-organizer').onClick(() => actions.organize()));
  };

  plugin.registerEvent(app.workspace.on('file-menu', (menu, file) => {
    const add: AddItem = build => { menu.addItem(build); };
    if (file instanceof TFile) fileItems(add, file); else if (file instanceof TFolder) folderItems(add, file);
  }));
  plugin.registerEvent(app.workspace.on('files-menu', (menu, files) => manyItems(build => { menu.addItem(build); }, files)));

  // Notebook Navigator renders its own menus and does not emit file-menu; use its public menu API (1.2.0+).
  let alive = true;
  let registeredApi: NavigatorApi | undefined;
  const navigatorDisposers: (() => void)[] = [];
  const clearNavigator = () => {
    registeredApi = undefined;
    for (const dispose of navigatorDisposers.splice(0)) { try { dispose(); } catch { /* The navigator may already be unloaded. */ } }
  };
  const registerNavigator = () => {
    if (!alive) return;
    const api = navigatorApi(plugin);
    if (api === registeredApi) return;
    clearNavigator();
    if (!api) return;
    registeredApi = api;
    navigatorDisposers.push(
      api.menus.registerFileMenu(({ addItem, file, selection }) => { if (selection.mode === 'multiple') manyItems(addItem, selection.files); else fileItems(addItem, file); }),
      api.menus.registerFolderMenu(({ addItem, folder }) => folderItems(addItem, folder)),
    );
  };
  plugin.register(() => { alive = false; clearNavigator(); });
  app.workspace.onLayoutReady(registerNavigator);
  plugin.registerEvent(app.workspace.on('layout-change', registerNavigator));

  const markers = new ExplorerMarkers(plugin, controller);
  plugin.register(controller.subscribe(() => markers.schedule()));
  plugin.registerEvent(app.workspace.on('layout-change', () => markers.schedule()));
  app.workspace.onLayoutReady(() => { if (alive) markers.schedule(); });
  plugin.register(() => markers.dispose());
}

function navigatorApi(plugin: Plugin): NavigatorApi | undefined {
  const plugins = (plugin.app as unknown as { plugins?: { plugins?: Record<string, { api?: unknown } | undefined> } }).plugins?.plugins;
  const api = plugins?.['notebook-navigator']?.api as Partial<NavigatorApi> | undefined;
  if (!api?.menus || typeof api.menus.registerFileMenu !== 'function' || typeof api.menus.registerFolderMenu !== 'function' || typeof api.getVersion !== 'function') return undefined;
  const [major = 0, minor = 0] = api.getVersion().split('.').map(Number);
  return major > 1 || (major === 1 && minor >= 2) ? api as NavigatorApi : undefined;
}

/**
 * Dots and an inbox count in Obsidian's own file explorer. The explorer has no public
 * decoration API, so this probes its item map and silently does nothing when absent.
 */
class ExplorerMarkers {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly marked = new Set<HTMLElement>();
  private readonly observers = new Map<HTMLElement, MutationObserver>();
  constructor(private readonly plugin: Plugin, private readonly controller: OrganizerController) {}
  schedule(): void { clearTimeout(this.timer); this.timer = setTimeout(() => this.apply(), 120); }
  private apply(): void {
    for (const element of this.marked) { delete element.dataset[MARKER]; delete element.dataset[COUNT]; }
    this.marked.clear();
    const settings = this.controller.settings();
    const leaves = this.plugin.app.workspace.getLeavesOfType('file-explorer');
    for (const [container, observer] of this.observers) if (!leaves.some(leaf => leaf.view.containerEl === container)) { observer.disconnect(); this.observers.delete(container); }
    if (!settings.explorerMarkers || !settings.inbox) return;
    const ready = this.controller.state().filing.filter(entry => entry.status === 'ready');
    for (const leaf of leaves) {
      const items = (leaf.view as unknown as { fileItems?: Record<string, ExplorerItem | undefined> }).fileItems;
      if (!items || typeof items !== 'object') continue;
      this.observe(leaf.view.containerEl);
      for (const entry of ready) this.mark(items[entry.path]?.selfEl, MARKER, 'ready');
      if (ready.length) this.mark(items[settings.inbox]?.selfEl, COUNT, String(ready.length));
    }
  }
  private mark(element: HTMLElement | undefined, key: string, value: string): void {
    if (!(element instanceof HTMLElement)) return;
    element.dataset[key] = value; this.marked.add(element);
  }
  private observe(container: HTMLElement): void {
    if (this.observers.has(container)) return;
    // Expanding a folder can render rows lazily; mark them once they appear.
    const observer = new MutationObserver(() => this.schedule());
    observer.observe(container, { childList: true, subtree: true });
    this.observers.set(container, observer);
  }
  dispose(): void {
    clearTimeout(this.timer);
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
    for (const element of this.marked) { delete element.dataset[MARKER]; delete element.dataset[COUNT]; }
    this.marked.clear();
  }
}
