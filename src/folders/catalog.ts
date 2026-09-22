import { excluded, safePath, within } from '../core/paths';
import type { OrganizerSettings } from '../settings';
import type { FolderCatalog, FolderSnapshot, FolderTarget } from './types';

export class MemoryFolderCatalog implements FolderCatalog {
  private current: FolderSnapshot = { revision: 0, targets: [] };
  refresh(paths: readonly string[], settings: OrganizerSettings): void {
    const rules = new Map(settings.folderRules.map(rule => [rule.path, rule]));
    const targets: FolderTarget[] = [];
    for (const path of [...new Set(paths)].sort()) {
      try { if (safePath(path) !== path) continue; } catch { continue; }
      if ((settings.inbox && within(path, settings.inbox)) || excluded(path, settings.excludedPaths) || excluded(path, settings.excludedDestinations)) continue;
      const rule = rules.get(path);
      if (rule?.acceptsNotes === false) continue;
      const ancestors = [...rules.values()].filter(item => within(path, item.path)).sort((a, b) => a.path.split('/').length - b.path.split('/').length);
      targets.push({ id: path, path, directPurpose: rule?.purpose ?? '', effectiveRules: ancestors.flatMap(item => [...item.subtreeRules]) });
    }
    if (JSON.stringify(targets) !== JSON.stringify(this.current.targets)) this.current = { revision: this.current.revision + 1, targets };
  }
  snapshot(): FolderSnapshot { return structuredClone(this.current); }
  get(id: string): FolderTarget | undefined { const target = this.current.targets.find(item => item.id === id); return target && structuredClone(target); }
}
