import { EditorSuggest, type App, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo, type TFile } from 'obsidian';
import type { OrganizerController } from './types';
import type { TargetMatch } from '../linking/target-search';
import { normalize } from '../linking/terms';
import { node } from './dom';
import { t } from '../i18n';

export const QUERY_PREFIX = '[[?';
const MAX_QUERY = 64, VERIFY_DELAY_MS = 600;
interface QueryItem { readonly match: TargetMatch; readonly recommended: boolean }

/** `[[?match|display` on one line before the caret; includes an auto-inserted `]]` after it (docs/link-matching.md §8). */
export function parseLinkQuery(line: string, ch: number): { start: number; end: number; match: string; display: string } | null {
  const before = line.slice(0, ch), at = before.lastIndexOf(QUERY_PREFIX);
  if (at < 0) return null;
  const query = before.slice(at + QUERY_PREFIX.length);
  if (query.length > MAX_QUERY || query.includes(']]') || query.includes('[[')) return null;
  const split = query.search(/[|｜]/);
  const match = (split < 0 ? query : query.slice(0, split)).trim(), display = split < 0 ? '' : query.slice(split + 1).trim();
  return { start: at, end: ch + (line.slice(ch, ch + 2) === ']]' ? 2 : 0), match, display };
}
/** Alias shown in the note: the typed display text, else the typed match when it differs from the title. */
export function linkAlias(match: string, display: string, title: string): string | undefined {
  if (display) return display;
  return match && normalize(match) !== normalize(title) ? match : undefined;
}

export class LinkQuerySuggest extends EditorSuggest<QueryItem> {
  private recommendation: { key: string; noteId: number | null } | null = null;
  private pending: { key: string; timer: ReturnType<typeof setTimeout> } | null = null;
  constructor(app: App, private readonly controller: OrganizerController) { super(app); this.limit = 12; }
  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!file) return null;
    const query = parseLinkQuery(editor.getLine(cursor.line), cursor.ch);
    if (!query) return null;
    return { start: { line: cursor.line, ch: query.start }, end: { line: cursor.line, ch: query.end }, query: editor.getLine(cursor.line).slice(query.start + QUERY_PREFIX.length, cursor.ch) };
  }
  getSuggestions(context: EditorSuggestContext): QueryItem[] {
    const query = parseLinkQuery(QUERY_PREFIX + context.query, QUERY_PREFIX.length + context.query.length);
    if (!query?.match) return [];
    const matches = this.controller.searchLinkTargets(query.match, context.file.path);
    const key = context.file.path + '\u0000' + query.match + '\u0000' + matches.map(item => item.target.noteId).join(',');
    const recommended = this.recommendation?.key === key ? this.recommendation.noteId : null;
    this.scheduleCheck(key, context, query.match, matches);
    const items = matches.map(match => ({ match, recommended: match.target.noteId === recommended }));
    return [...items.filter(item => item.recommended), ...items.filter(item => !item.recommended)];
  }
  /** One model check after typing pauses, only when there is a real choice to make. */
  private scheduleCheck(key: string, context: EditorSuggestContext, match: string, matches: readonly TargetMatch[]): void {
    if (this.pending?.key === key || this.recommendation?.key === key) return;
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    if (match.length < 2 || matches.length < 2 || !this.controller.settings().verifyOnHover) return;
    const text = context.editor.getLine(context.start.line), line = text.slice(0, context.start.ch) + match + text.slice(context.end.ch);
    const timer = setTimeout(() => {
      void this.controller.verifyLinkQuery(context.file.path, match, line, matches.map(item => item.target)).then(noteId => {
        if (this.pending?.key !== key) return;
        this.pending = null; this.recommendation = { key, noteId };
        // Re-rank the open list; without the internal hook the badge appears on the next keystroke.
        const current = this.context, list = (this as unknown as { suggestions?: { setSuggestions?(items: QueryItem[]): void } }).suggestions;
        if (current && typeof list?.setSuggestions === 'function') list.setSuggestions(this.getSuggestions(current));
      }, () => { if (this.pending?.key === key) this.pending = null; });
    }, VERIFY_DELAY_MS);
    this.pending = { key, timer };
  }
  renderSuggestion(item: QueryItem, element: HTMLElement): void {
    element.addClass?.('note-organizer-query-item');
    const title = node(element, 'div', item.match.target.title, 'note-organizer-query-title');
    if (item.recommended) node(title, 'span', t('query.recommended'), 'note-organizer-query-badge');
    node(element, 'div', item.match.target.path.replace(/\.md$/, ''), 'note-organizer-muted');
  }
  selectSuggestion(item: QueryItem): void {
    const context = this.context;
    if (!context) return;
    const query = parseLinkQuery(QUERY_PREFIX + context.query, QUERY_PREFIX.length + context.query.length);
    const link = this.controller.linkMarkdown(item.match.target.path, context.file.path, linkAlias(query?.match ?? '', query?.display ?? '', item.match.target.title));
    context.editor.replaceRange(link, context.start, context.end);
    this.close();
  }
}
