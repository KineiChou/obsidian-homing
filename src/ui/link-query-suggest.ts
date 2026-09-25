import { EditorSuggest, Notice, type App, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo, type TFile } from 'obsidian';
import type { OrganizerController } from './types';
import type { TargetMatch } from '../linking/target-search';
import { normalize } from '../linking/terms';
import { node } from './dom';
import { errorText, t } from '../i18n';
import { OrganizerError } from '../core/errors';

export const QUERY_PREFIX = '[[?';
const MAX_QUERY = 64, VERIFY_DELAY_MS = 600;
interface ActiveQuery {
  readonly key: string;
  readonly editor: Editor;
  readonly file: TFile;
  readonly path: string;
  readonly start: EditorPosition;
  readonly end: EditorPosition;
  readonly line: string;
  readonly query: string;
  readonly match: string;
  readonly display: string;
  readonly settingsKey: string;
  timer?: number;
  checking: boolean;
  selected?: number | null;
}
interface QueryItem { readonly match: TargetMatch; readonly recommended: boolean; readonly source: ActiveQuery }
const samePosition = (a: EditorPosition, b: EditorPosition) => a.line === b.line && a.ch === b.ch;

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
  private active: ActiveQuery | null = null;
  constructor(app: App, private readonly controller: OrganizerController) { super(app); this.limit = 12; }
  private settingsKey(): string {
    const settings = this.controller.settings();
    return JSON.stringify([settings.provider, settings.endpoint, settings.modelId, settings.secretName, settings.verifyOnHover, settings.linkScope, settings.excludedPaths]);
  }
  private cancel(): void { if (this.active) window.clearTimeout(this.active.timer); this.active = null; }
  close(): void { this.cancel(); super.close(); }
  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    const query = file ? parseLinkQuery(editor.getLine(cursor.line), cursor.ch) : null;
    if (!query) { this.cancel(); return null; }
    return { start: { line: cursor.line, ch: query.start }, end: { line: cursor.line, ch: query.end }, query: editor.getLine(cursor.line).slice(query.start + QUERY_PREFIX.length, cursor.ch) };
  }
  getSuggestions(context: EditorSuggestContext): QueryItem[] {
    const query = parseLinkQuery(QUERY_PREFIX + context.query, QUERY_PREFIX.length + context.query.length);
    const line = context.editor.getLine(context.start.line), raw = line.slice(context.start.ch, context.end.ch), expected = QUERY_PREFIX + context.query;
    if (!query?.match || context.start.line !== context.end.line || (raw !== expected && raw !== expected + ']]')) { this.cancel(); return []; }
    const matches = this.controller.searchLinkTargets(query.match, context.file.path), settingsKey = this.settingsKey();
    const key = JSON.stringify([context.file.path, context.start, context.end, line, settingsKey, matches.map(item => [item.target.noteId, item.target.revision, item.target.path])]);
    if (this.active?.key !== key || this.active.editor !== context.editor || this.active.file !== context.file) {
      this.cancel();
      this.active = { key, editor: context.editor, file: context.file, path: context.file.path, start: { ...context.start }, end: { ...context.end }, line, query: context.query, match: query.match, display: query.display, settingsKey, checking: false };
    }
    const source = this.active;
    this.scheduleCheck(source, matches);
    const items = matches.map(match => ({ match, recommended: match.target.noteId === source.selected, source }));
    return [...items.filter(item => item.recommended), ...items.filter(item => !item.recommended)];
  }
  private current(source: ActiveQuery): boolean {
    const context = this.context;
    return this.active === source && !!context && context.editor === source.editor && context.file === source.file && context.file.path === source.path &&
      context.query === source.query && samePosition(context.start, source.start) && samePosition(context.end, source.end) &&
      source.editor.getLine(source.start.line) === source.line && this.settingsKey() === source.settingsKey;
  }
  /** The captured object identifies one live query, even when A → B → A reuses the same text. */
  private scheduleCheck(source: ActiveQuery, matches: readonly TargetMatch[]): void {
    if (source.checking || source.selected !== undefined || source.match.length < 2 || matches.length < 2 || !this.controller.settings().verifyOnHover) return;
    source.checking = true;
    source.timer = window.setTimeout(() => {
      if (!this.current(source)) { if (this.active === source) this.cancel(); return; }
      const line = source.line.slice(0, source.start.ch) + source.match + source.line.slice(source.end.ch);
      void this.controller.verifyLinkQuery(source.path, source.match, line, matches.map(item => item.target), () => this.current(source)).then(noteId => {
        if (!this.current(source)) return;
        source.checking = false; source.selected = noteId;
        // Re-rank the open list; without the internal hook the badge appears on the next keystroke.
        const current = this.context, list = (this as unknown as { suggestions?: { setSuggestions?(items: QueryItem[]): void } }).suggestions;
        if (current && typeof list?.setSuggestions === 'function') list.setSuggestions(this.getSuggestions(current));
      }, () => { if (this.active === source) source.checking = false; });
    }, VERIFY_DELAY_MS);
  }
  renderSuggestion(item: QueryItem, element: HTMLElement): void {
    element.addClass?.('note-organizer-query-item');
    const title = node(element, 'div', item.match.target.title, 'note-organizer-query-title');
    if (item.recommended) node(title, 'span', t('query.recommended'), 'note-organizer-query-badge');
    node(element, 'div', item.match.target.path.replace(/\.md$/, ''), 'note-organizer-muted');
  }
  selectSuggestion(item: QueryItem): void {
    const source = item.source;
    try {
      if (!this.current(source)) throw new OrganizerError('stale', 'error.linkStale');
      const target = item.match.target;
      const link = this.controller.linkMarkdown(target, source.path, linkAlias(source.match, source.display, target.title));
      source.editor.replaceRange(link, source.start, source.end);
    } catch (error) { new Notice(errorText(error)); }
    this.close();
  }
}
