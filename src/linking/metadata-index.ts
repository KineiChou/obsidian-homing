import type { LinkTarget, Match, MatchResult, MetadataIndex } from './types';
import { fold, graphemeBoundaries, wordBoundary } from './text-boundaries';

interface Node { label: string; children: Map<string, Node>; targets: Set<number> }
function node(label = ''): Node { return { label, children: new Map(), targets: new Set() }; }
interface Document { target: LinkTarget; terms: Set<string> }

export class MemoryMetadataIndex implements MetadataIndex {
  private readonly root = node();
  private readonly documents = new Map<number, Document>();
  private generation = 0;
  get epoch(): number { return this.generation; }
  get size(): number { return this.documents.size; }

  upsert(input: LinkTarget): void {
    const target: LinkTarget = Object.freeze({ ...input,
      aliases: Object.freeze(input.aliases.slice(0, 32)), tags: Object.freeze(input.tags.slice(0, 8)),
      description: input.description.slice(0, 160) });
    const terms = new Set([target.title, ...target.aliases].filter(term => term.length >= 2 && term.length <= 64).map(fold));
    const previous = this.documents.get(target.noteId);
    let changed = false;
    for (const term of previous?.terms ?? []) if (!terms.has(term)) { this.deleteTerm(term, target.noteId); changed = true; }
    for (const term of terms) if (!previous?.terms.has(term)) { this.insert(term, target.noteId); changed = true; }
    this.documents.set(target.noteId, { target, terms });
    if (changed) this.generation++;
  }

  remove(noteId: number): void {
    const previous = this.documents.get(noteId);
    if (!previous) return;
    for (const term of previous.terms) this.deleteTerm(term, noteId);
    this.documents.delete(noteId);
    if (previous.terms.size) this.generation++;
  }
  get(noteId: number): LinkTarget | undefined { return this.documents.get(noteId)?.target; }
  clear(): void {
    if (this.root.children.size) this.generation++;
    this.documents.clear(); this.root.children.clear();
  }

  match(text: string, offset = 0): MatchResult {
    const normalized = fold(text);
    const boundaries = graphemeBoundaries(text);
    const matches: Match[] = [];
    let hits = 0, limited = false, consumed = 0;
    for (let from = 0; from < text.length; from++) {
      if (from < consumed || !boundaries.has(from)) continue;
      let current = this.root, at = from;
      let longest: Match | undefined;
      while (at < normalized.length) {
        const next = current.children.get(normalized[at]!);
        if (!next || !normalized.startsWith(next.label, at)) break;
        at += next.label.length; current = next;
        if (!current.targets.size || !boundaries.has(at) || !wordBoundary(text, from, at)) continue;
        hits++;
        if (current.targets.size > 128) { limited = true; longest = undefined; }
        else longest = { from: from + offset, to: at + offset, text: text.slice(from, at), noteIds: [...current.targets] };
        if (hits >= 128) { limited = true; break; }
      }
      if (longest) { matches.push(longest); consumed = longest.to - offset; }
      if (hits >= 128) break;
    }
    return { matches, limited };
  }

  private insert(term: string, noteId: number): void {
    let current = this.root, rest = term;
    while (rest) {
      const child = current.children.get(rest[0]!);
      if (!child) { const leaf = node(rest); leaf.targets.add(noteId); current.children.set(rest[0]!, leaf); return; }
      let shared = 0;
      while (shared < rest.length && shared < child.label.length && rest[shared] === child.label[shared]) shared++;
      if (shared < child.label.length) {
        const branch = node(child.label.slice(0, shared));
        current.children.set(rest[0]!, branch);
        child.label = child.label.slice(shared); branch.children.set(child.label[0]!, child);
        current = branch;
      } else current = child;
      rest = rest.slice(shared);
    }
    current.targets.add(noteId);
  }

  private deleteTerm(term: string, noteId: number): void {
    const chain: { parent: Node; key: string; child: Node }[] = [];
    let current = this.root, at = 0;
    while (at < term.length) {
      const key = term[at]!, child = current.children.get(key);
      if (!child || !term.startsWith(child.label, at)) return;
      chain.push({ parent: current, key, child }); at += child.label.length; current = child;
    }
    current.targets.delete(noteId);
    for (const { parent, key, child } of chain.reverse()) {
      if (child.targets.size) continue;
      if (!child.children.size) parent.children.delete(key);
      else if (child.children.size === 1) {
        const only = child.children.values().next().value as Node;
        only.label = child.label + only.label; parent.children.set(key, only);
      }
    }
  }
}
