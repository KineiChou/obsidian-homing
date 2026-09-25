import { parentPath } from '../core/paths';
import type { EditorSnapshot, LinkGraph, LinkInput, LinkTarget, LocalMention, MentionMatcher, MetadataIndex, RankedCandidate, ScanRequest, TextRange } from './types';
import { graphemeBoundaries, tokens, wordBoundary } from './text-boundaries';
import { KIND_WEIGHT, isShortTerm, normalize } from './terms';
import { MemoryLinkGraph } from './link-graph';

export const CANDIDATE_LIMIT = 8;
const DERIVED_TARGET_LIMIT = 3;
const SENTENCE_END = /[。！？.!?\n]/;

function overlap(context: ReadonlySet<string>, text: string): number {
  let count = 0;
  for (const token of tokens(text)) if (context.has(token)) count++;
  return count;
}
const top = (path: string) => path.split('/')[0] ?? '';
function folderScore(source: string, target: string): number {
  if (parentPath(source) === parentPath(target)) return 1;
  return top(source) === top(target) && source.includes('/') && target.includes('/') ? .5 : 0;
}

/** Local sentence around [from, to) within [min, max), in the same coordinates as `text`. */
export function sentenceRange(text: string, from: number, to: number, min = 0, max = text.length, span = 240): TextRange {
  let start = Math.max(min, from - span), end = Math.min(max, to + span);
  const before = text.slice(start, from);
  let last = -1;
  for (let i = before.length - 1; i >= 0; i--) if (SENTENCE_END.test(before[i]!)) { last = i; break; }
  if (last >= 0) start += last + 1;
  const after = text.slice(to, end).search(SENTENCE_END);
  if (after >= 0) end = to + after + 1;
  return { from: start, to: end };
}

/** Title/alias/derived matches with statistics-based ranking and confidence tiers (docs/link-matching.md §3–5). */
export class LocalMentionMatcher implements MentionMatcher {
  constructor(private readonly index: MetadataIndex, private readonly graph: LinkGraph = new MemoryLinkGraph(), private readonly candidateLimit = CANDIDATE_LIMIT) {}

  scan(request: ScanRequest): LocalMention[] {
    const mentions: LocalMention[] = [];
    const limit = Math.max(1, Math.min(20, Math.floor(this.candidateLimit) || CANDIDATE_LIMIT));
    for (const match of this.index.match(request.text, request.offset).matches) {
      const range = request.allowedRanges.find(item => item.from <= match.from && item.to >= match.to);
      if (!range || request.ignoredTerms.has(normalize(match.text.trim()))) continue;
      const raw = match.noteIds.flatMap(noteId => {
        const target = this.index.get(noteId);
        return target && target.noteId !== request.sourceNoteId && !request.linkedNoteIds.has(noteId) && request.allowed(target) ? [{ target, kind: match.kinds[noteId] ?? 'derived' }] : [];
      });
      if (!raw.length || (raw.every(item => item.kind === 'derived') && raw.length > DERIVED_TARGET_LIMIT)) continue;
      const counts = this.graph.anchorCounts(match.text);
      let total = 0; for (const count of counts.values()) total += count;
      const local = sentenceRange(request.text, match.from - request.offset, match.to - request.offset, Math.max(0, range.from - request.offset), Math.min(request.text.length, range.to - request.offset));
      const sentence = request.text.slice(local.from, local.to), at = match.from - request.offset - local.from;
      const context = tokens(sentence.slice(0, at) + ' ' + sentence.slice(at + match.text.length));
      for (const token of tokens(match.text)) context.delete(token);
      const ranked: RankedCandidate[] = raw.map(({ target, kind }) => {
        const commonness = ((counts.get(target.noteId) ?? 0) + .5) / (total + .5 * raw.length);
        const related = this.graph.relatedness(request.sourceNoteId, target.noteId);
        const lexical = Math.min(1, (overlap(context, target.tags.join(' ')) + overlap(context, [target.title, ...target.aliases].join(' ')) + overlap(context, target.path)) / 3);
        const score = KIND_WEIGHT[kind] * (.6 + .4 * commonness) + .25 * related + .1 * folderScore(request.sourcePath, target.path) + .05 * lexical;
        return { target, kind, score, commonness, related };
      }).sort((a, b) => b.score - a.score || (a.target.path < b.target.path ? -1 : a.target.path > b.target.path ? 1 : 0));
      if (ranked.length > limit && ranked[limit - 1]!.score === ranked[limit]!.score) continue;
      const candidates = ranked.slice(0, limit);
      mentions.push({ from: match.from, to: match.to, text: match.text, candidates, tier: this.tier(match.text, candidates, raw.length, counts, total) });
    }
    return mentions;
  }

  private tier(text: string, candidates: readonly RankedCandidate[], size: number, counts: ReadonlyMap<number, number>, total: number): LocalMention['tier'] {
    const [first, second] = candidates;
    if (!first || first.kind === 'derived') return 'uncertain';
    if (size === 1) return !isShortTerm(text) || (counts.get(first.target.noteId) ?? 0) >= 1 ? 'confident' : 'uncertain';
    if (total >= 3 && first.commonness >= .8) return 'confident';
    if (first.related >= .4 && (second?.related ?? 0) === 0) return 'confident';
    return 'uncertain';
  }

  /** Model inputs for the mentions in an editor snapshot, with sentence-only context. */
  inputs(snapshot: EditorSnapshot, allowed: (target: LinkTarget) => boolean, options: { ignoredTerms?: ReadonlySet<string>; limit?: number } = {}): readonly LinkInput[] {
    const boundaries = graphemeBoundaries(snapshot.text.slice(0, snapshot.text.length + 2));
    const mentions = this.scan({ sourceNoteId: snapshot.noteId, sourcePath: snapshot.path, text: snapshot.text, offset: snapshot.contextFrom, allowedRanges: snapshot.allowedRanges, linkedNoteIds: snapshot.linkedNoteIds, ignoredTerms: options.ignoredTerms ?? new Set(), allowed });
    const result: LinkInput[] = [];
    for (const mention of mentions) {
      const localFrom = mention.from - snapshot.contextFrom, localTo = mention.to - snapshot.contextFrom;
      if (!boundaries.has(localTo) || !wordBoundary(snapshot.text, localFrom, localTo)) continue;
      const range = snapshot.allowedRanges.find(item => item.from <= mention.from && item.to >= mention.to)!;
      const local = sentenceRange(snapshot.text, localFrom, localTo, Math.max(0, range.from - snapshot.contextFrom), Math.min(snapshot.text.length, range.to - snapshot.contextFrom));
      const contextFrom = snapshot.contextFrom + local.from, contextTo = snapshot.contextFrom + local.to;
      if (snapshot.dirtyRanges && !snapshot.dirtyRanges.some(item => item.from <= contextTo && item.to >= contextFrom)) continue;
      result.push({ catalogueEpoch: this.index.epoch, candidates: mention.candidates.map(candidate => candidate.target),
        anchor: { editorSessionId: snapshot.sessionId, noteId: snapshot.noteId, sourcePath: snapshot.path, documentRevision: snapshot.revision,
          from: mention.from, to: mention.to, originalText: mention.text, contextFrom, contextText: snapshot.text.slice(local.from, local.to) } });
      if (result.length === (options.limit ?? 3)) break;
    }
    return result;
  }
}
