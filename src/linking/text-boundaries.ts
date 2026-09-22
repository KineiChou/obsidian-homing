/** ASCII folding preserves the original UTF-16 offsets. */
export function fold(text: string): string { return text.replace(/[A-Z]/g, char => char.toLowerCase()); }

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
