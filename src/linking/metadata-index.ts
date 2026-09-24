import type { LinkTarget, Match, MatchResult, MetadataIndex, TermKind } from './types';
import { cjkBoundaryChecker, fold, graphemeBoundariesIfComplex, wordBoundary } from './text-boundaries';
import { hasCjk, isCjk, termsFor } from './terms';

interface Node { label: string; children: Map<string, Node>; targets: Map<number, TermKind> }
function node(label = ''): Node { return { label, children: new Map(), targets: new Map() }; }
interface Document { target: LinkTarget; terms: Map<string, TermKind> }
const firstChar = (text: string, at: number) => String.fromCodePoint(text.codePointAt(at) ?? 0);
function lastChar(text: string, end: number): string { const low = text.charCodeAt(end - 1); return text.slice(end - (low >= 0xdc00 && low <= 0xdfff ? 2 : 1), end); }

export class MemoryMetadataIndex implements MetadataIndex {
  private readonly root = node();
  private readonly entries = new Map<number, Document>();
  private generation = 0;
  get epoch(): number { return this.generation; }
  get size(): number { return this.entries.size; }

  upsert(input: LinkTarget): void {
    const target: LinkTarget = Object.freeze({ ...input,
      aliases: Object.freeze(input.aliases.slice(0, 32)), tags: Object.freeze(input.tags.slice(0, 8)),
      description: input.description.slice(0, 160) });
    const terms = termsFor(target.title, target.aliases);
    const previous = this.entries.get(target.noteId);
    let changed = false;
    for (const term of previous?.terms.keys() ?? []) if (!terms.has(term)) { this.deleteTerm(term, target.noteId); changed = true; }
    for (const [term, kind] of terms) if (previous?.terms.get(term) !== kind) { this.insert(term, target.noteId, kind); changed = true; }
    this.entries.set(target.noteId, { target, terms });
    if (changed) this.generation++;
  }

  remove(noteId: number): void {
    const previous = this.entries.get(noteId);
    if (!previous) return;
    for (const term of previous.terms.keys()) this.deleteTerm(term, noteId);
    this.entries.delete(noteId);
    if (previous.terms.size) this.generation++;
  }
  get(noteId: number): LinkTarget | undefined { return this.entries.get(noteId)?.target; }
  documents(): Iterable<{ readonly target: LinkTarget; readonly terms: ReadonlyMap<string, TermKind> }> { return this.entries.values(); }
  clear(): void {
    if (this.root.children.size) this.generation++;
    this.entries.clear(); this.root.children.clear();
  }

  match(text: string, offset = 0): MatchResult {
    const normalized = fold(text);
    const graphemes = graphemeBoundariesIfComplex(text), boundary = (at: number) => !graphemes || graphemes.has(at);
    // Chinese has no spaces: a term must start and end on word boundaries, so 学习 is not found inside 深度学习.
    const words = hasCjk(text) ? cjkBoundaryChecker(text) : null;
    const aligned = (from: number, to: number) => !words || ((!isCjk(firstChar(text, from)) || words(from)) && (!isCjk(lastChar(text, to)) || words(to)));
    const matches: Match[] = [];
    let hits = 0, limited = false, consumed = 0;
    for (let from = 0; from < text.length; from++) {
      if (from < consumed || !boundary(from)) continue;
      let current = this.root, at = from;
      let longest: Match | undefined;
      while (at < normalized.length) {
        const next = current.children.get(normalized[at]!);
        if (!next || !normalized.startsWith(next.label, at)) break;
        at += next.label.length; current = next;
        if (!current.targets.size || !boundary(at) || !wordBoundary(text, from, at) || !aligned(from, at)) continue;
        hits++;
        if (current.targets.size > 128) { limited = true; longest = undefined; }
        else longest = { from: from + offset, to: at + offset, text: text.slice(from, at), noteIds: [...current.targets.keys()], kinds: Object.fromEntries(current.targets) };
        if (hits >= 128) { limited = true; break; }
      }
      if (longest) { matches.push(longest); consumed = longest.to - offset; }
      if (hits >= 128) break;
    }
    return { matches, limited };
  }

  private insert(term: string, noteId: number, kind: TermKind): void {
    let current = this.root, rest = term;
    while (rest) {
      const child = current.children.get(rest[0]!);
      if (!child) { const leaf = node(rest); leaf.targets.set(noteId, kind); current.children.set(rest[0]!, leaf); return; }
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
    current.targets.set(noteId, kind);
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
