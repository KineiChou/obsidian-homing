import { byteLength } from '../jev/request';
import type { NoteSnapshot } from './types';

export interface PreparedNote { readonly note: NoteSnapshot; readonly excerpt?: { readonly originalChars: number; readonly sentChars: number } }
const BODY_BYTES = 12_000;
// Iterate code points so an excerpt cannot end in half of a surrogate pair.
export function utf8Prefix(text: string, budget: number): string {
  let bytes = 0; let result = '';
  for (const point of text) { bytes += new TextEncoder().encode(point).length; if (bytes > budget) break; result += point; }
  return result;
}
export function prepareNote(note: NoteSnapshot, strategy: 'excerpt' | 'full' = 'excerpt'): PreparedNote {
  const existing = (note as NoteSnapshot & { excerpt?: PreparedNote['excerpt'] }).excerpt;
  if (existing) return { note, excerpt: existing };
  if (strategy === 'full' || byteLength(note.body) <= BODY_BYTES) return { note };
  const lines = note.body.split('\n');
  const headings: string[] = []; const paragraphs: string[] = [];
  let afterHeading = false; let paragraph: string[] = [];
  const finish = () => { if (paragraph.length) paragraphs.push(utf8Prefix(paragraph.join('\n'), 480)); paragraph = []; };
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) { finish(); headings.push(utf8Prefix(line, 240)); afterHeading = true; }
    else if (afterHeading && line.trim()) paragraph.push(line);
    else if (afterHeading && paragraph.length) { finish(); afterHeading = false; }
  }
  finish();
  let body = ['[Heading outline]', utf8Prefix(headings.join('\n'), 3000), '[Opening]', utf8Prefix(note.body, 4000), '[Section openings]', utf8Prefix(paragraphs.join('\n'), 4800)].join('\n');
  while (byteLength(body) > BODY_BYTES) body = utf8Prefix(body, Math.floor(new TextEncoder().encode(body).length * 0.9));
  const excerpt = { originalChars: Array.from(note.body).length, sentChars: Array.from(body).length };
  const prepared = { ...note, body, excerpt };
  return { note: prepared, excerpt };
}
