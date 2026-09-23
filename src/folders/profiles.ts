import type { NoteSnapshot } from '../filing/types';
import type { FolderTarget } from './types';

export interface ProfileNote { readonly path: string; readonly title: string; readonly tags: readonly string[] }
export interface ProfiledTarget extends FolderTarget { readonly profile?: { readonly titles: readonly string[]; readonly tags: readonly string[] } }
function tokens(text: string): Set<string> {
  const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.flatMap(word => {
    if (!/[\p{Script=Han}]/u.test(word)) return [word];
    const points = Array.from(word);
    return points.slice(0, -1).map((char, i) => char + points[i + 1]);
  }).filter(word => word.length > 1));
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
      if (!notes.length) return target;
      const profile = { titles: notes.map(note => note.title), tags: [...new Set(notes.flatMap(note => note.tags))].slice(0, 16) };
      while (new TextEncoder().encode(JSON.stringify(profile)).length > 1000) {
        if (profile.titles.length > 1) profile.titles.pop(); else profile.tags.pop();
      }
      return { ...target, profile };
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
    const evidenceTargets = scores.filter(item => item.score > 0);
    const requiredIds = new Set([...protectedTargets.map(target => target.id), ...evidenceTargets.map(item => item.target.id)]);
    if (requiredIds.size > 64 || (scores[0]?.overlap ?? 0) < 2) return targets;
    const chosen = new Map(protectedTargets.map(target => [target.id, target]));
    for (const item of scores) { if (chosen.size >= 64) break; chosen.set(item.target.id, item.target); }
    return [...chosen.values()];
  }
}
