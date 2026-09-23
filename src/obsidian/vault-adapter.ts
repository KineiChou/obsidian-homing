import { App, TFile, TFolder, getFrontMatterInfo, parseYaml, parseLinktext, parseFrontMatterAliases, parseFrontMatterTags } from 'obsidian';
import type { MetadataIndex, LinkTarget } from '../linking/types';
import type { NoteSnapshot, SourceVersion } from '../filing/types';
import { contentHash, excluded, inInbox, safePath, within } from '../core/paths';
import { OrganizerError } from '../core/errors';
import type { OrganizerSettings } from '../settings';
import { inspectReferences, referencesSettled } from './reference-check';

export class VaultAdapter {
  private sequence = 0;
  private readonly ids = new WeakMap<TFile, number>();
  private readonly files = new Map<number, TFile>();
  private readonly revisions = new Map<number, number>();
  constructor(readonly app: App, private readonly index: MetadataIndex, private readonly settings: () => OrganizerSettings) {}
  identity(file: TFile): number {
    let id = this.ids.get(file);
    if (id === undefined) { id = ++this.sequence; this.ids.set(file, id); this.files.set(id, file); this.revisions.set(id, 0); }
    return id;
  }
  file(path: string): TFile | null { return this.app.vault.getFileByPath(path); }
  id(path: string): number | null { const file = this.file(path); return file ? this.identity(file) : null; }
  currentPath(id: number): string | null { const file = this.files.get(id); return file && this.file(file.path) === file ? file.path : null; }
  revision(path: string): number | null { const id = this.id(path); return id === null ? null : this.revisions.get(id) ?? 0; }
  allowed(path: string): boolean {
    try { safePath(path); return !excluded(path, this.settings().excludedPaths); } catch { return false; }
  }
  eligible(path: string): boolean { const s = this.settings(); return path.endsWith('.md') && this.allowed(path) && inInbox(path, s.inbox, s.includeSubfolders); }
  linkSource(path: string): boolean { return this.allowed(path) && (this.settings().linkScope === 'vault' || this.eligible(path)); }
  touch(file: TFile): void { const id = this.identity(file); this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1); }
  metadata(file: TFile): void {
    const id = this.identity(file);
    if (file.extension !== 'md' || !this.allowed(file.path)) { this.index.remove(id); return; }
    const cache = this.app.metadataCache.getFileCache(file);
    const description: unknown = cache?.frontmatter?.description;
    const previous = this.index.get(id);
    const value: LinkTarget = { noteId: id, path: file.path, title: file.basename, aliases: (parseFrontMatterAliases(cache?.frontmatter) ?? []).slice(0, 32), tags: (parseFrontMatterTags(cache?.frontmatter) ?? []).slice(0, 8), description: typeof description === 'string' ? description.slice(0, 160) : '', revision: this.revisions.get(id) ?? 0 };
    if (previous && (previous.path !== value.path || previous.title !== value.title || JSON.stringify(previous.aliases) !== JSON.stringify(value.aliases) || JSON.stringify(previous.tags) !== JSON.stringify(value.tags) || previous.description !== value.description)) {
      this.touch(file);
    }
    this.index.upsert({ ...value, revision: this.revisions.get(id) ?? 0 });
  }
  remove(file: TFile): void { const id = this.ids.get(file); if (id !== undefined) { this.index.remove(id); this.files.delete(id); this.revisions.delete(id); } }
  removeUnder(path: string): void { for (const file of this.files.values()) if (within(file.path, path)) this.remove(file); }
  allFolders(): string[] { return this.app.vault.getAllFolders(false).map(folder => folder.path).filter(path => this.allowed(path)); }
  async source(path: string): Promise<SourceVersion | null> {
    const file = this.file(path);
    if (!file) return null;
    const noteId = this.identity(file), revision = this.revisions.get(noteId) ?? 0, modifiedAt = file.stat.mtime;
    const text = await this.app.vault.read(file);
    const active = this.app.workspace.activeEditor;
    if (active?.file === file && active.editor && active.editor.getValue() !== text) throw new OrganizerError('stale', '笔记仍在保存，请稍后重试。');
    const hash = await contentHash(text);
    if (file.path !== path || this.file(path) !== file || revision !== this.revisions.get(noteId) || file.stat.mtime !== modifiedAt) throw new OrganizerError('stale', '笔记已改变，请重新分析。');
    return { noteId, path, revision, contentHash: hash };
  }
  async note(path: string, manual: boolean): Promise<NoteSnapshot> {
    const file = this.file(path);
    if (!file || !this.eligible(path)) throw new OrganizerError('missing', '笔记不在当前收件箱范围内。');
    const noteId = this.identity(file), revision = this.revisions.get(noteId) ?? 0, modifiedAt = file.stat.mtime;
    const active = this.app.workspace.activeEditor;
    const text = manual && active?.file === file && active.editor ? active.editor.getValue() : await this.app.vault.read(file);
    const hash = await contentHash(text);
    if (file.path !== path || this.revisions.get(noteId) !== revision || file.stat.mtime !== modifiedAt) throw new OrganizerError('stale', '笔记已改变，请重新分析。');
    const info = getFrontMatterInfo(text);
    let tags: string[] = [];
    if (info.exists) {
      try {
        const properties: unknown = parseYaml(info.frontmatter);
        if (properties && typeof properties === 'object') {
          const raw: unknown = (properties as Record<string, unknown>).tags;
          tags = (typeof raw === 'string' ? raw.split(/[,\s]+/) : Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []).slice(0, 8);
        }
      } catch { throw new OrganizerError('unsafe', '笔记属性无法解析，请修正后再分析。'); }
    }
    return { source: { noteId, path, revision, contentHash: hash }, title: file.basename, body: info.exists ? text.slice(info.contentStart) : text, tags };
  }
  linkedTargets(path: string, text?: string): ReadonlySet<number> {
    const result = new Set<number>();
    for (const target of Object.keys(this.app.metadataCache.resolvedLinks[path] ?? {})) { const id = this.id(target); if (id !== null) result.add(id); }
    if (text !== undefined) {
      for (const match of text.matchAll(/\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]|\[[^\]\n]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
        const raw = match[1] ?? match[2]; if (!raw) continue;
        let link = raw; try { link = decodeURI(raw); } catch { /* Keep literal vault paths. */ }
        const file = this.app.metadataCache.getFirstLinkpathDest(parseLinktext(link).path, path);
        if (file) result.add(this.identity(file));
      }
    }
    return result;
  }
  referencesSafe(path: string, destination: string): boolean | string {
    const source = this.file(path);
    return source ? inspectReferences(this.app, source, destination).issue ?? true : '笔记已不存在。';
  }
  async rename(from: string, to: string): Promise<void> {
    const file = this.file(from);
    if (!file || this.app.vault.getAbstractFileByPath(to)) throw new OrganizerError('conflict', '笔记已移动或目标位置已被占用。');
    const folder = this.app.vault.getAbstractFileByPath(to.slice(0, to.lastIndexOf('/')));
    if (!(folder instanceof TFolder)) throw new OrganizerError('missing', '目标目录已不存在。');
    const inspection = inspectReferences(this.app, file, to);
    if (inspection.issue) throw new OrganizerError('unsafe', inspection.issue);
    await this.app.fileManager.renameFile(file, to);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (referencesSettled(this.app, inspection)) return;
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
    throw new OrganizerError('unsafe', '笔记已移动，但链接更新尚未核实，请检查移动记录。');
  }
}
