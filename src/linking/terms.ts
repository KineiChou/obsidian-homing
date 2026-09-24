import type { TermKind } from './types';

/** Kind weights from docs/link-matching.md §2. */
export const KIND_WEIGHT: Readonly<Record<TermKind, number>> = { title: 1, alias: .95, inflection: .85, derived: .6 };
const KIND_ORDER: Readonly<Record<TermKind, number>> = { title: 3, alias: 2, inflection: 1, derived: 0 };
export function strongerKind(a: TermKind, b: TermKind): TermKind { return KIND_ORDER[a] >= KIND_ORDER[b] ? a : b; }

/** Per UTF-16 unit, so offsets in the normalized text equal offsets in the original. */
export function normalize(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let unit = code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : code === 0x3000 ? ' ' : text[i]!;
    const lower = unit.toLowerCase();
    if (lower.length === 1) unit = lower;
    out += unit;
  }
  return out;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN_ONLY = /^[\p{Script=Latin}\p{N}_ .'-]+$/u;
export function isCjk(char: string): boolean { return CJK.test(char); }
export function hasCjk(text: string): boolean { return CJK.test(text); }
/** Short terms need evidence or a model check before they count as confident (§5). */
export function isShortTerm(term: string): boolean {
  const chars = Array.from(term.trim());
  if (chars.every(isCjk)) return chars.length <= 2;
  return LATIN_ONLY.test(term) && chars.length < 4;
}

const STOP = new Set(['笔记', '学习笔记', '读书笔记', '总结', '小结', '入门', '简介', '概述', '介绍', '教程', '草稿', '随笔', '日记', '周报', '月报', '会议', '记录', '索引', '目录',
  'notes', 'note', 'summary', 'intro', 'introduction', 'overview', 'tutorial', 'guide', 'draft', 'todo', 'index', 'readme', 'misc']);
const WRAPPERS: readonly [string, string][] = [['《', '》'], ['「', '」'], ['『', '』'], ['"', '"'], ['“', '”']];
const PREFIX = [/^\d{4}[-./年]?\d{1,2}(?:[-./月]\d{1,2}日?)?[\s_-]*/u, /^\d{1,3}[.、)）]\s*/u];
const SUFFIX = /[\s_-]*(?:学习笔记|读书笔记|笔记|总结|小结|入门|简介|概述|介绍|教程|notes|note|summary|introduction|intro|overview|tutorial|guide)$/iu;
const SEPARATORS = /\s[-–—]\s|[：:|｜/、，,]/u;

/** Accepts a term for the index (§2.2); derived terms are stricter. */
export function acceptableTerm(term: string, derived: boolean): boolean {
  const value = term.trim();
  if (value.length < 2 || value.length > 64) return false;
  if (derived && STOP.has(normalize(value))) return false;
  const chars = Array.from(value);
  if (chars.every(isCjk)) return chars.length >= 2;
  if (LATIN_ONLY.test(value)) return value.replace(/[\s.'-]/g, '').length >= (derived ? 4 : 3);
  return true;
}

function unwrap(text: string): string {
  for (const [open, close] of WRAPPERS) if (text.startsWith(open) && text.endsWith(close) && text.length > 2) return text.slice(open.length, -close.length).trim();
  return text;
}
function stripAffixes(text: string): string {
  let value = unwrap(text.trim());
  for (const prefix of PREFIX) value = value.replace(prefix, '');
  for (let previous = ''; previous !== value;) { previous = value; value = value.replace(SUFFIX, '').trim(); }
  return unwrap(value);
}

/** Shorter keyphrases a title is likely to be mentioned by (§2.3). */
export function deriveTerms(term: string): string[] {
  const results = new Set<string>();
  const add = (value: string) => { const trimmed = value.trim(); if (trimmed) results.add(trimmed); };
  const base = stripAffixes(term);
  add(base);
  const bracket = /^(.*?)[（(]([^（）()]+)[）)]\s*(.*)$/u.exec(base);
  if (bracket) { add(stripAffixes(bracket[1]! + ' ' + bracket[3]!)); add(stripAffixes(bracket[2]!)); }
  for (const source of [base, ...(bracket ? [bracket[1]!] : [])]) {
    if (SEPARATORS.test(source)) for (const part of source.split(SEPARATORS)) add(stripAffixes(part));
  }
  results.delete(term.trim());
  return [...results].filter(value => acceptableTerm(value, true));
}

/** English plural forms only; no general stemming (§2.4). */
export function inflections(term: string): string[] {
  const value = term.trim();
  if (value.length < 3 || !/[a-z]$/iu.test(value)) return [];
  const forms = [value + 's'];
  if (/(?:s|x|z|ch|sh)$/iu.test(value)) forms.push(value + 'es');
  if (/[^aeiou]y$/iu.test(value)) forms.push(value.slice(0, -1) + 'ies');
  return forms.filter(form => form.length <= 64);
}

/** Every indexed term of one note with its strongest kind. */
export function termsFor(title: string, aliases: readonly string[]): Map<string, TermKind> {
  const terms = new Map<string, TermKind>();
  const add = (value: string, kind: TermKind) => {
    if (!acceptableTerm(value, kind === 'derived')) return;
    const key = normalize(value.trim()), previous = terms.get(key);
    terms.set(key, previous ? strongerKind(previous, kind) : kind);
  };
  const sources: [string, TermKind][] = [[title, 'title'], ...aliases.map((alias): [string, TermKind] => [alias, 'alias'])];
  for (const [value, kind] of sources) {
    add(value, kind);
    for (const form of inflections(value)) add(form, 'inflection');
    for (const derived of deriveTerms(value)) { add(derived, 'derived'); for (const form of inflections(derived)) add(form, 'derived'); }
  }
  return terms;
}
