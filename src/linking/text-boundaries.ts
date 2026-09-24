import { normalize } from './terms';

/** Case and width folding that preserves the original UTF-16 offsets. */
export function fold(text: string): string { return normalize(text); }

let words: Intl.Segmenter | null | undefined;
function wordSegmenter(): Intl.Segmenter | null {
  if (words === undefined) { try { words = new Intl.Segmenter('zh', { granularity: 'word' }); } catch { words = null; } }
  return words;
}
/**
 * Word boundaries for Chinese, Japanese and Korean text. Returns null when the
 * runtime has no word segmenter, in which case callers skip the CJK check.
 */
export function cjkWordBoundaries(text: string): Set<number> | null {
  const segmenter = wordSegmenter();
  if (!segmenter) return null;
  const boundaries = new Set<number>([0, text.length]);
  for (const part of segmenter.segment(text)) { boundaries.add(part.index); boundaries.add(part.index + part.segment.length); }
  return boundaries;
}
const RUN_BREAK = /[\s\p{P}\p{S}]/u;
/**
 * Lazily segments only the run (between spaces or punctuation) around a queried
 * offset, so a sparse scan does not segment the whole viewport.
 */
export function cjkBoundaryChecker(text: string): ((at: number) => boolean) | null {
  if (!wordSegmenter()) return null;
  const runs = new Map<number, { end: number; boundaries: Set<number> }>();
  return at => {
    if (at <= 0 || at >= text.length || RUN_BREAK.test(text[at - 1]!) || RUN_BREAK.test(text[at]!)) return true;
    let start = at; while (start > 0 && !RUN_BREAK.test(text[start - 1]!)) start--;
    let run = runs.get(start);
    if (!run) {
      let end = at; while (end < text.length && !RUN_BREAK.test(text[end]!)) end++;
      const boundaries = cjkWordBoundaries(text.slice(start, end))!;
      run = { end, boundaries }; runs.set(start, run);
    }
    return run.boundaries.has(at - start);
  };
}
const COMPLEX = /[\p{M}\u200d\ud800-\udfff\ufe0e\ufe0f\r]/u;
/** Null means every offset is a grapheme boundary (no marks, joiners, surrogates or CRLF). */
export function graphemeBoundariesIfComplex(text: string): Set<number> | null { return COMPLEX.test(text) ? graphemeBoundaries(text) : null; }

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function graphemeBoundaries(text: string): Set<number> {
  const boundaries = new Set<number>([0, text.length]);
  for (const part of segmenter.segment(text)) boundaries.add(part.index);
  return boundaries;
}

const latin = /[\p{Script=Latin}\p{N}_]/u;
function before(text: string, at: number): string {
  while (at > 0) {
    const last = text.charCodeAt(at - 1);
    const char = text.slice(at - (last >= 0xdc00 && last <= 0xdfff ? 2 : 1), at);
    if (!/\p{M}/u.test(char)) return char;
    at -= char.length;
  }
  return '';
}
export function wordBoundary(text: string, from: number, to: number): boolean {
  const first = String.fromCodePoint(text.codePointAt(from) ?? 0);
  const last = before(text, to);
  return !(latin.test(first) && latin.test(before(text, from))) &&
    !(latin.test(last) && latin.test(String.fromCodePoint(text.codePointAt(to) ?? 0)));
}

export function tokens(text: string): Set<string> {
  const result = new Set<string>();
  for (const word of fold(text).match(/[\p{Script=Latin}\p{N}_]+|[\p{Script=Han}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars = Array.from(word);
      if (chars.length === 1) result.add(word);
      for (let i = 1; i < chars.length; i++) result.add(chars[i - 1]! + chars[i]!);
    } else result.add(word);
  }
  return result;
}
