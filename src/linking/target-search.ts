import { parentPath } from '../core/paths';
import type { LinkGraph, LinkTarget, MetadataIndex, TermKind } from './types';
import { normalize } from './terms';

export interface TargetMatch { readonly target: LinkTarget; readonly kind: TermKind; readonly matched: string; readonly rank: number }
/** Returns a relevance score for `text`, or null when it does not match. Scores may be negative (Obsidian fuzzy search). */
export type FuzzyScorer = (text: string) => number | null;
export interface TargetQuery {
  readonly scorer: FuzzyScorer;
  readonly query: string;
  readonly sourceNoteId: number | null;
  readonly sourcePath: string;
  allowed(target: LinkTarget): boolean;
  readonly limit?: number;
}

/** Explicit `[[?` search over titles, aliases and derived terms (docs/link-matching.md §8). */
export function searchTargets(index: MetadataIndex, graph: LinkGraph, query: TargetQuery): TargetMatch[] {
  const hits: { target: LinkTarget; kind: TermKind; matched: string; fuzzy: number }[] = [];
  for (const { target, terms } of index.documents()) {
    if (target.noteId === query.sourceNoteId || !query.allowed(target)) continue;
    let best: { kind: TermKind; matched: string; fuzzy: number } | undefined;
    for (const [term, kind] of [[normalize(target.title), 'title'] as const, ...terms]) {
      const fuzzy = query.scorer(term);
      if (fuzzy !== null && (!best || fuzzy > best.fuzzy)) best = { kind, matched: term, fuzzy };
    }
    if (best) hits.push({ target, ...best });
  }
  if (!hits.length) return [];
  // Obsidian fuzzy scores are relative; map them to 0–1 within this result set.
  const high = Math.max(...hits.map(hit => hit.fuzzy)), low = Math.min(...hits.map(hit => hit.fuzzy));
  const linked = query.sourceNoteId === null ? new Map<number, number>() : graph.anchorCounts(query.query);
  return hits.map(hit => {
    const fuzzy = high === low ? 1 : (hit.fuzzy - low) / (high - low);
    const related = query.sourceNoteId === null ? 0 : graph.relatedness(query.sourceNoteId, hit.target.noteId);
    const folder = parentPath(query.sourcePath) === parentPath(hit.target.path) ? 1 : 0;
    return { target: hit.target, kind: hit.kind, matched: hit.matched, rank: fuzzy + .25 * related + .1 * folder + ((linked.get(hit.target.noteId) ?? 0) >= 1 ? .2 : 0) };
  }).sort((a, b) => b.rank - a.rank || a.target.path.localeCompare(b.target.path)).slice(0, query.limit ?? 12);
}
