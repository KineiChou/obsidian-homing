import type { NoteSnapshot } from '../filing/types';
import type { FolderTarget } from './types';

export interface ProfileNote { readonly path: string; readonly title: string; readonly tags: readonly string[] }
export interface ProfiledTarget extends FolderTarget { readonly profile?: { readonly titles: readonly string[]; readonly tags: readonly string[] } }
function tokens(text: string): Set<string> {
  const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.flatMap(word => /[\p{Script=Han}]/u.test(word) ? Array.from(word).slice(0, -1).map((char, i) => char + Array.from(word)[i + 1]) : [word]).filter(word => word.length > 1));
}
/** Bounded local metadata only. Callers opt in before enriching a request. */
export class MemoryFolderProfiles {
  private readonly notes = new Map<string, ProfileNote>();
  upsert(note: ProfileNote): void {
    this.notes.delete(note.path);
    this.notes.set(note.path, { path: note.path, title: Array.from(note.title).slice(0, 120).join(''), tags: note.tags.slice(0, 12).map(tag => Array.from(tag).slice(0, 80).join('')) });
    if (this.notes.size > 20_000) this.notes.delete(this.notes.keys().next().value!);
  }
  remove(path: string): void { this.notes.delete(path); }
  clear(): void { this.notes.clear(); }
  enrich(targets: readonly FolderTarget[]): ProfiledTarget[] {
    const byFolder = new Map<string, ProfileNote[]>();
    for (const note of this.notes.values()) {
      const folder = note.path.slice(0, note.path.lastIndexOf('/'));
      const items = byFolder.get(folder) ?? []; if (items.length < 8) items.push(note); byFolder.set(folder, items);
    }
    return targets.map(target => {
      const notes = byFolder.get(target.path) ?? [];
      return { ...target, ...(notes.length ? { profile: { titles: notes.map(note => note.title), tags: [...new Set(notes.flatMap(note => note.tags))].slice(0, 16) } } : {}) };
    });
  }
  prefilter(note: NoteSnapshot, targets: readonly ProfiledTarget[]): readonly ProfiledTarget[] {
    if (targets.length <= 254) return targets;
    const query = tokens([note.title, ...note.tags, note.body.slice(0, 12000)].join(' '));
    const scores = targets.map(target => {
      const manual = tokens([target.path, target.directPurpose, ...target.effectiveRules].join(' '));
      const metadata = tokens([...(target.profile?.titles ?? []), ...(target.profile?.tags ?? [])].join(' '));
      let score = 0; let overlap = 0;
      for (const word of query) { if (manual.has(word)) { score += 3; overlap++; } else if (metadata.has(word)) { score++; overlap++; } }
      return { target, score, overlap };
    }).sort((a, b) => b.score - a.score || a.target.path.localeCompare(b.target.path));
    // Preserve all explicitly configured destinations; weak or broad signals use full grouping.
    const protectedTargets = targets.filter(target => target.directPurpose || target.effectiveRules.length);
    if (protectedTargets.length > 64 || (scores[0]?.overlap ?? 0) < 2 || scores.filter(item => item.score > 0).length > 64) return targets;
    const chosen = new Map(protectedTargets.map(target => [target.id, target]));
    for (const item of scores) { if (chosen.size >= 64) break; chosen.set(item.target.id, item.target); }
    return [...chosen.values()];
  }
}
