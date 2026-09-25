import { StateField } from '@codemirror/state';
import { vi } from 'vitest';
import type { MarkdownFileInfo } from 'obsidian';
export { Setting, SecretComponent, PluginSettingTab, Modal, FuzzySuggestModal } from './settings';

export const editorInfoField = StateField.define<MarkdownFileInfo>({ create: () => ({ file: null }) as MarkdownFileInfo, update: value => value });
export const requestUrl = vi.fn();
export function setIcon(element: HTMLElement, icon: string): void { element.dataset.icon = icon; }
export function setTooltip(element: HTMLElement, tooltip: string): void { element.dataset.tooltip = tooltip; }
export const notices: string[] = [];
export class Notice { constructor(message: string | DocumentFragment) { notices.push(typeof message === 'string' ? message : message.textContent ?? ''); } }
export class MarkdownView {}
export function prepareFuzzySearch(query: string) { const needle = query.toLowerCase(); return (text: string) => text.toLowerCase().includes(needle) ? { score: -text.length, matches: [] } : null; }
export class EditorSuggest<T> {
  context: { editor: unknown; file: { path: string }; start: { line: number; ch: number }; end: { line: number; ch: number }; query: string } | null = null;
  limit = 100;
  constructor(readonly app: unknown) {}
  close(): void { this.context = null; }
  declare readonly items?: T[];
}
export class Menu {}
export class TFile {
  stat = { ctime: 0, mtime: 0, size: 0 };
  constructor(public path: string, public body = '') { this.stat.size = body.length; }
  get extension(): string { return this.path.split('.').at(-1) ?? ''; }
  get basename(): string { return this.path.split('/').at(-1)!.replace(/\.md$/, ''); }
  get name(): string { return this.path.split('/').at(-1)!; }
}
export class TFolder { children: (TFile | TFolder)[] = []; constructor(public path: string) {} }
export function getFrontMatterInfo(text: string) { const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text); return { exists: !!match, frontmatter: match?.[1] ?? '', from: 0, to: match?.[0].length ?? 0, contentStart: match?.[0].length ?? 0 }; }
export function parseYaml(text: string): unknown { return Object.fromEntries(text.split('\n').map(line => { const at = line.indexOf(':'); const value = line.slice(at + 1).trim(); return [line.slice(0, at), value.startsWith('[') ? JSON.parse(value) as unknown : value]; })); }
export function parseFrontMatterAliases(value: Record<string, unknown> | undefined): string[] { const aliases = value?.aliases; return Array.isArray(aliases) ? aliases.filter((item): item is string => typeof item === 'string') : typeof aliases === 'string' ? [aliases] : []; }
export function parseFrontMatterTags(value: Record<string, unknown> | undefined): string[] { const tags = value?.tags; return Array.isArray(tags) ? tags.filter((item): item is string => typeof item === 'string') : typeof tags === 'string' ? [tags] : []; }
export function parseLinktext(link: string) { const index = link.indexOf('#'); return { path: index < 0 ? link : link.slice(0, index), subpath: index < 0 ? '' : link.slice(index) }; }

type Listener = (...args: unknown[]) => void;
class Events {
  private readonly listeners = new Map<string, Set<Listener>>();
  on(event: string, listener: Listener) { const set = this.listeners.get(event) ?? new Set<Listener>(); set.add(listener); this.listeners.set(event, set); return { off: () => set.delete(listener) }; }
  emit(event: string, ...args: unknown[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...args); }
}
export class FakeApp {
  readonly files = new Map<string, TFile | TFolder>();
  readonly caches = new Map<TFile, Record<string, unknown>>();
  readonly local = new Map<string, unknown>();
  readonly config = new Map<string, unknown>();
  readonly saveLocalStorage = vi.fn((key: string, value: unknown) => { this.local.set(key, structuredClone(value)); });
  loadLocalStorage = (key: string) => this.local.get(key);
  readonly secretStorage = { getSecret: (name: string) => name === 'key' ? 'test-secret' : null };
  readonly vault = Object.assign(new Events(), {
    getFileByPath: (path: string) => { const file = this.files.get(path); return file instanceof TFile ? file : null; },
    getAbstractFileByPath: (path: string) => this.files.get(path) ?? null,
    getMarkdownFiles: () => [...this.files.values()].filter((file): file is TFile => file instanceof TFile && file.extension === 'md'),
    getAllFolders: () => [...this.files.values()].filter((file): file is TFolder => file instanceof TFolder),
    getFiles: () => [...this.files.values()].filter((file): file is TFile => file instanceof TFile),
    getConfig: (key: string) => this.config.get(key),
    read: vi.fn(async (file: TFile) => file.body),
    createFolder: async (path: string) => { const folder = new TFolder(path); this.files.set(path, folder); this.vault.emit('create', folder); return folder; },
  });
  readonly workspace = Object.assign(new Events(), {
    activeEditor: null as MarkdownFileInfo | null,
    onLayoutReady: (ready: () => void) => ready(),
    getActiveFile: () => this.workspace.activeEditor?.file ?? null,
    openLinkText: vi.fn(async () => undefined),
  });
  readonly metadataCache = Object.assign(new Events(), {
    resolvedLinks: {} as Record<string, Record<string, number>>,
    getFileCache: (file: TFile) => this.caches.get(file) ?? null,
    getFirstLinkpathDest: (path: string, source: string) => {
      if (/\.[^/.]+$/.test(path) && !path.endsWith('.md')) {
        const folder = source.slice(0, source.lastIndexOf('/') + 1), name = path.slice(path.lastIndexOf('/') + 1);
        return this.vault.getFileByPath(path) ?? this.vault.getFileByPath(folder + path) ?? (path.includes('/') ? null : this.vault.getFiles().find(file => file.name === name) ?? null);
      }
      const direct = this.vault.getFileByPath(path.endsWith('.md') ? path : path + '.md'); if (direct) return direct;
      const folder = source.slice(0, source.lastIndexOf('/') + 1);
      return this.vault.getFileByPath(folder + (path.endsWith('.md') ? path : path + '.md')) ?? this.vault.getMarkdownFiles().find(file => file.basename === path.replace(/\.md$/, '')) ?? null;
    },
  });
  readonly fileManager = {
    renameFile: vi.fn(async (file: TFile, path: string) => { const old = file.path; if (this.files.has(path)) throw Error('conflict'); this.files.delete(old); file.path = path; this.files.set(path, file); this.vault.emit('rename', file, old); }),
    generateMarkdownLink: (file: TFile, _source: string, _subpath: string | undefined, alias: string) => `[[${file.path.replace(/\.md$/, '')}|${alias}]]`,
  };
  add(path: string, body = ''): TFile { const file = new TFile(path, body); this.files.set(path, file); this.caches.set(file, {}); return file; }
}
export class Plugin {
  readonly callbacks: (() => void)[] = [];
  readonly extensions: unknown[] = [];
  data: unknown = null;
  constructor(readonly app: FakeApp) {}
  loadData = async () => this.data;
  saveData = vi.fn(async (value: unknown) => { this.data = structuredClone(value); });
  register(callback: () => void): void { this.callbacks.push(callback); }
  registerEvent(event: { off(): void }): void { this.callbacks.push(() => event.off()); }
  registerEditorExtension(extension: unknown): void { this.extensions.push(extension); }
  unload(): void { for (const callback of this.callbacks) callback(); }
}
