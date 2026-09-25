/** An existing link around a cursor offset, in the same UTF-16 coordinates as the scanned text. */
export interface LinkAtCursor {
  readonly from: number;
  readonly to: number;
  /** The link source exactly as written, e.g. `[[Folder/Note|shown]]`. */
  readonly text: string;
  /** The text a reader sees, kept when the link is removed. */
  readonly display: string;
  /** The link target as written, without heading or block references. */
  readonly target: string;
}

const WIKI = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MARKDOWN = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;

/**
 * The wiki or Markdown link containing `offset` (inclusive of both ends). Embeds are not links
 * to unlink, so they return null.
 */
export function linkAt(text: string, offset: number): LinkAtCursor | null {
  for (const match of text.matchAll(WIKI)) {
    const from = match.index, to = from + match[0].length;
    if (offset < from || offset > to) continue;
    if (match[1]) return null;
    const inner = match[2]!, bar = inner.indexOf('|');
    const target = (bar < 0 ? inner : inner.slice(0, bar)).trim(), alias = bar < 0 ? '' : inner.slice(bar + 1).trim();
    const path = target.split('#')[0]!.replace(/\.md$/i, '');
    const display = alias || (target.includes('#') ? target.replace(/\.md(?=#)/i, '') : path);
    return display ? { from, to, text: match[0], display, target: path } : null;
  }
  for (const match of text.matchAll(MARKDOWN)) {
    const from = match.index, to = from + match[0].length;
    if (offset < from || offset > to) continue;
    if (match[1] || !match[2]!.trim()) return null;
    let target = match[3]!.trim().split(/\s/)[0]!;
    try { target = decodeURI(target); } catch { /* Keep the literal target. */ }
    return { from, to, text: match[0], display: match[2]!, target: target.split('#')[0]!.replace(/\.md$/i, '') };
  }
  return null;
}
