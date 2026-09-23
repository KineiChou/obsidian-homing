import { type App, type TFile, parseLinktext } from 'obsidian';

const categories = ['links', 'embeds', 'frontmatterLinks'] as const;
interface Reference { readonly source: TFile; readonly category: typeof categories[number]; readonly index: number; readonly target: TFile }
export interface ReferenceInspection { readonly issue: string | null; readonly references: readonly Reference[] }
function updatesLinks(app: App): boolean {
  const vault: unknown = app.vault;
  try { return typeof vault === 'object' && vault !== null && 'getConfig' in vault && typeof vault.getConfig === 'function' && vault.getConfig('alwaysUpdateLinks') === true; }
  catch { return false; }
}
export function inspectReferences(app: App, source: TFile, destination: string): ReferenceInspection {
  const references: Reference[] = [], automatic = updatesLinks(app);
  const uniqueBasename = !app.vault.getMarkdownFiles().some(file => file !== source && file.basename === source.basename);
  const incoming = Object.entries(app.metadataCache.resolvedLinks).filter(([path, targets]) => path !== source.path && targets[source.path]).map(([path]) => app.vault.getFileByPath(path));
  for (const file of [source, ...incoming]) {
    const metadata = file && app.metadataCache.getFileCache(file);
    if (!file || !metadata) return { issue: `无法核对 ${file?.path ?? source.path} 的链接，请等待索引完成。`, references };
    for (const category of categories) {
      for (const [index, link] of (metadata[category] ?? []).entries()) {
        let path = parseLinktext(link.link).path;
        try { path = decodeURI(path); } catch { /* Literal paths can contain percent signs. */ }
        if (!path || /^[a-z]+:/i.test(path)) continue;
        const target = app.metadataCache.getFirstLinkpathDest(path, file.path);
        if (file !== source && target !== source) continue;
        if (!target) return { issue: `${file.path} 中的链接 ${link.link} 尚未解析，无法确认移动安全。`, references };
        references.push({ source: file, category, index, target });
        if (automatic) continue;
        if (file === source && app.metadataCache.getFirstLinkpathDest(path, destination) !== target) return { issue: `移动将改变 ${file.path} 中的链接 ${link.link}；请先启用自动更新内部链接。`, references };
        if (file !== source && (path.replace(/\.md$/, '') !== source.basename || !uniqueBasename)) return { issue: `${file.path} 通过 ${link.link} 引用此笔记；请先启用自动更新内部链接。`, references };
      }
    }
  }
  return { issue: null, references };
}
export function referencesSettled(app: App, inspection: ReferenceInspection): boolean {
  return inspection.references.every(reference => {
    if (app.vault.getFileByPath(reference.source.path) !== reference.source || app.vault.getFileByPath(reference.target.path) !== reference.target) return false;
    const link = app.metadataCache.getFileCache(reference.source)?.[reference.category]?.[reference.index];
    if (!link) return false;
    let path = parseLinktext(link.link).path;
    try { path = decodeURI(path); } catch { /* Keep literal paths. */ }
    return app.metadataCache.getFirstLinkpathDest(path, reference.source.path) === reference.target;
  });
}
