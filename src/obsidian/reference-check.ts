import { type App, type TFile, parseLinktext } from 'obsidian';

import { translateMessage } from '../i18n';

const categories = ['links', 'embeds', 'frontmatterLinks'] as const;
interface Reference { readonly source: TFile; readonly category: typeof categories[number]; readonly index: number; readonly target: TFile }
export interface ReferenceInspection { readonly issue: string | null; readonly references: readonly Reference[] }
/** Reads a vault option from Obsidian's (unpublished) config accessor; undefined when unavailable. */
export function vaultConfig(app: App, key: string): unknown {
  const vault: unknown = app.vault;
  try { return typeof vault === 'object' && vault !== null && 'getConfig' in vault && typeof vault.getConfig === 'function' ? (vault as { getConfig(key: string): unknown }).getConfig(key) : undefined; }
  catch { return undefined; }
}
export function updatesLinks(app: App): boolean { return vaultConfig(app, 'alwaysUpdateLinks') === true; }
export function inspectReferences(app: App, source: TFile, destination: string): ReferenceInspection {
  const references: Reference[] = [], automatic = updatesLinks(app);
  const uniqueBasename = !app.vault.getMarkdownFiles().some(file => file !== source && file.basename === source.basename);
  const incoming = Object.entries(app.metadataCache.resolvedLinks).filter(([path, targets]) => path !== source.path && targets[source.path]).map(([path]) => app.vault.getFileByPath(path));
  for (const file of [source, ...incoming]) {
    const metadata = file && app.metadataCache.getFileCache(file);
    if (!file || !metadata) return { issue: translateMessage('host.referenceIndex', { path: file?.path ?? source.path }), references };
    for (const category of categories) {
      for (const [index, link] of (metadata[category] ?? []).entries()) {
        let path = parseLinktext(link.link).path;
        try { path = decodeURI(path); } catch { /* Literal paths can contain percent signs. */ }
        if (!path || /^[a-z]+:/i.test(path)) continue;
        const target = app.metadataCache.getFirstLinkpathDest(path, file.path);
        if (file !== source && target !== source) continue;
        if (!target) return { issue: translateMessage('host.referenceUnresolved', { path: file.path, link: link.link }), references };
        references.push({ source: file, category, index, target });
        if (automatic) continue;
        if (file === source && app.metadataCache.getFirstLinkpathDest(path, destination) !== target) return { issue: translateMessage('host.referenceOutgoing', { path: file.path, link: link.link }), references };
        if (file !== source && (path.replace(/\.md$/, '') !== source.basename || !uniqueBasename)) return { issue: translateMessage('host.referenceIncoming', { path: file.path, link: link.link }), references };
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
