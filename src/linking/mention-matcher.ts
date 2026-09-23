import type { EditorSnapshot, LinkInput, LinkTarget, MentionMatcher, MetadataIndex } from './types';
import { graphemeBoundaries, tokens, wordBoundary } from './text-boundaries';

function overlap(context: ReadonlySet<string>, text: string): number {
  let count = 0;
  for (const token of tokens(text)) if (context.has(token)) count++;
  return count;
}
function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i]! - a[i]!;
  return 0;
}

export class LocalMentionMatcher implements MentionMatcher {
  constructor(private readonly index: MetadataIndex, private readonly candidateLimit = 8) {}

  inputs(snapshot: EditorSnapshot, allowed: (target: LinkTarget) => boolean): readonly LinkInput[] {
    const result: LinkInput[] = [];
    const boundaries = graphemeBoundaries(snapshot.text.slice(0, 1202));
    let end = Math.min(snapshot.text.length, 1200);
    while (end > 0 && !boundaries.has(end)) end--;
    const text = snapshot.text.slice(0, end);
    const limit = Math.max(1, Math.min(20, Math.floor(this.candidateLimit) || 8));
    for (const match of this.index.match(text, snapshot.contextFrom).matches) {
      const allowedRange = snapshot.allowedRanges.find(range => range.from <= match.from && range.to >= match.to);
      if (!allowedRange) continue;
      const localFrom = match.from - snapshot.contextFrom, localTo = match.to - snapshot.contextFrom;
      if (!boundaries.has(localTo) || !wordBoundary(snapshot.text, localFrom, localTo)) continue;
      let contextFrom = Math.max(snapshot.contextFrom, allowedRange.from);
      let contextTo = Math.min(snapshot.contextFrom + text.length, allowedRange.to);
      // Only the containing sentence is decisive; unrelated sentences cannot invalidate it.
      const before = text.slice(contextFrom - snapshot.contextFrom, localFrom);
      const delimiters = [...before.matchAll(/[。！？.!?\n]/g)];
      const last = delimiters[delimiters.length - 1];
      if (last) contextFrom += last.index! + last[0].length;
      const after = text.slice(localTo, contextTo - snapshot.contextFrom);
      const boundary = after.search(/[。！？.!?\n]/);
      if (boundary >= 0) contextTo = match.to + boundary + 1;
      if (snapshot.dirtyRanges && !snapshot.dirtyRanges.some(range => range.from <= contextTo && range.to >= contextFrom)) continue;
      const contextText = text.slice(contextFrom - snapshot.contextFrom, contextTo - snapshot.contextFrom);
      const context = tokens(contextText.slice(0, match.from - contextFrom) + ' ' + contextText.slice(match.to - contextFrom));
      for (const token of tokens(match.text)) context.delete(token);
      const ranked = match.noteIds.flatMap(noteId => {
        const target = this.index.get(noteId);
        if (!target || target.noteId === snapshot.noteId || snapshot.linkedNoteIds.has(noteId) || !allowed(target)) return [];
        return [{ target, score: [overlap(context, target.tags.join(' ')),
          overlap(context, [target.title, ...target.aliases].join(' ')), overlap(context, target.path)] }];
      }).sort((a, b) => compare(a.score, b.score));
      if (!ranked.length || (ranked.length > limit && compare(ranked[limit - 1]!.score, ranked[limit]!.score) === 0)) continue;
      result.push({ catalogueEpoch: this.index.epoch, candidates: ranked.slice(0, limit).map(item => item.target),
        anchor: { editorSessionId: snapshot.sessionId, noteId: snapshot.noteId, sourcePath: snapshot.path,
          documentRevision: snapshot.revision, from: match.from, to: match.to, originalText: match.text,
          contextFrom, contextText } });
      if (result.length === 3) break;
    }
    return result;
  }
}
