import type { LinkGraph } from './types';
import { normalize } from './terms';

interface Contribution { readonly targetId: number; readonly anchor: string }

/**
 * Anchor-text counts and link adjacency built from resolved metadata only
 * (docs/link-matching.md §4). Each source's contribution is replaced as a whole,
 * so an edited or deleted note never leaves stale counts behind.
 */
export class MemoryLinkGraph implements LinkGraph {
  private readonly sources = new Map<number, readonly Contribution[]>();
  private readonly anchors = new Map<string, Map<number, number>>();
  private readonly outgoing = new Map<number, Map<number, number>>();
  private readonly incoming = new Map<number, Map<number, number>>();

  replaceSource(sourceId: number, links: readonly { readonly targetId: number; readonly anchor: string }[]): void {
    this.retract(sourceId);
    const contributions = links.flatMap(link => {
      const anchor = normalize(link.anchor.trim());
      return link.targetId !== sourceId && anchor.length >= 2 && anchor.length <= 64 ? [{ targetId: link.targetId, anchor }] : [];
    });
    if (!contributions.length) return;
    this.sources.set(sourceId, contributions);
    for (const { targetId, anchor } of contributions) {
      bump(this.anchors, anchor, targetId, 1); bump(this.outgoing, sourceId, targetId, 1); bump(this.incoming, targetId, sourceId, 1);
    }
  }
  removeNote(noteId: number): void {
    this.retract(noteId);
    // Links pointing at a removed note stay with their sources until those sources change;
    // candidates are only ever drawn from the live index, so they are simply never looked up.
  }
  anchorCounts(anchor: string): ReadonlyMap<number, number> { return this.anchors.get(normalize(anchor.trim())) ?? new Map(); }
  relatedness(sourceId: number, targetId: number): number {
    const source = this.outgoing.get(sourceId), neighbours = new Set([...this.outgoing.get(targetId)?.keys() ?? [], ...this.incoming.get(targetId)?.keys() ?? []]);
    neighbours.delete(sourceId);
    let shared = 0;
    if (source && neighbours.size) for (const id of source.keys()) if (neighbours.has(id)) shared++;
    const cosine = source?.size && neighbours.size ? shared / Math.sqrt(source.size * neighbours.size) : 0;
    const reciprocal = this.outgoing.get(targetId)?.has(sourceId) ? .3 : 0;
    return Math.min(1, cosine + reciprocal);
  }
  clear(): void { this.sources.clear(); this.anchors.clear(); this.outgoing.clear(); this.incoming.clear(); }
  private retract(sourceId: number): void {
    for (const { targetId, anchor } of this.sources.get(sourceId) ?? []) {
      bump(this.anchors, anchor, targetId, -1); bump(this.outgoing, sourceId, targetId, -1); bump(this.incoming, targetId, sourceId, -1);
    }
    this.sources.delete(sourceId);
  }
}
function bump<K>(map: Map<K, Map<number, number>>, key: K, id: number, delta: number): void {
  const counts = map.get(key) ?? new Map<number, number>();
  const next = (counts.get(id) ?? 0) + delta;
  if (next > 0) counts.set(id, next); else counts.delete(id);
  if (counts.size) map.set(key, counts); else map.delete(key);
}
