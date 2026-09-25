import { setIcon, setTooltip } from 'obsidian';
import { StateEffect, type Extension, type Range } from '@codemirror/state';
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import type { LinkMention, OrganizerController } from './types';
import type { LinkTarget } from '../linking/types';
import { linkAt, type LinkAtCursor } from '../linking/link-syntax';
import { button, node } from './dom';
import { errorText, t } from '../i18n';

export interface LinkHintHost {
  sessionId(view: EditorView): string | undefined;
  chooseTarget(candidates: readonly LinkTarget[], choose: (noteId: number) => void): void;
}
/** What a cursor command acts on: an existing link first, else a suggested mention. */
export type CursorTarget = { kind: 'link'; session: string; link: LinkAtCursor } | { kind: 'mention'; session: string; mention: LinkMention };
export interface LinkHints {
  readonly extension: Extension;
  acceptAtCursor(checking?: boolean): boolean;
  targetAtCursor(): CursorTarget | null;
}

/** After an edit, the mention under the caret stays undecorated for this long (docs/link-matching.md §7). */
export const QUIET_MS = 1500;
const HOVER_MS = 300, CURSOR_MS = 700, LEAVE_MS = 250;
const refresh = StateEffect.define<null>();
const ATTRIBUTE = 'data-note-organizer-mentions';
const breadcrumb = (path: string) => path.replace(/\.md$/, '').split('/').join(' › ');
/** The folder a note sits in, as a breadcrumb; the note's own title is shown separately. */
const folderOf = (path: string) => breadcrumb(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const idOf = (mention: { from: number; to: number }) => `${mention.from}:${mention.to}`;
const settled = (mention: LinkMention) => mention.tier === 'confident' || mention.verified !== undefined;
// Popout editors can send DOM nodes from another window's realm.
const isNode = (value: EventTarget | null): value is Node => !!value && 'nodeType' in value;
type Check = { state: 'pending' } | { state: 'done'; selected: number | null } | { state: 'failed'; message: string };

class MarkerWidget extends WidgetType {
  constructor(private readonly ids: readonly string[]) { super(); }
  eq(other: MarkerWidget): boolean { return other.ids.join() === this.ids.join(); }
  toDOM(view: EditorView): HTMLElement {
    // Obsidian installs its DOM helpers in every window; use the editor's own so popout widgets stay in their realm.
    const marker = (view.dom.ownerDocument.win as Window & { createSpan: typeof createSpan }).createSpan({ cls: 'note-organizer-link-marker' });
    marker.setAttribute(ATTRIBUTE, this.ids.join(' ')); marker.setAttribute('aria-label', t('hint.marker', { count: this.ids.length }));
    setIcon(marker, 'link'); return marker;
  }
  ignoreEvent(): boolean { return false; }
}

/** Local, network-free link hints; the model is asked only for uncertain mentions, on hover. */
export function linkHints(controller: OrganizerController, host: LinkHintHost): LinkHints {
  const views = new Set<LinkHintView>();
  let lastFocused: LinkHintView | null = null;
  const focused = (hint: LinkHintView) => { lastFocused = hint; };
  const extension = ViewPlugin.define(view => { const hint: LinkHintView = new LinkHintView(view, controller, host, () => { views.delete(hint); if (lastFocused === hint) lastFocused = null; }, focused); views.add(hint); return hint; }, {
    decorations: value => value.decorations,
    eventHandlers: {
      mouseover(event) { this.hover(event); },
      mouseout(event) { this.leave(event); },
    },
  });
  const current = () => [...views].find(item => item.view.hasFocus) ?? (lastFocused?.view.dom.isConnected ? lastFocused : undefined);
  return {
    extension,
    // The command palette takes focus from the editor, so fall back to the editor that had it last.
    acceptAtCursor: (checking = false) => current()?.acceptAtCursor(checking) ?? false,
    targetAtCursor: () => current()?.targetAtCursor() ?? null,
  };
}

class LinkHintView {
  decorations: DecorationSet = Decoration.none;
  private mentions: LinkMention[] = [];
  private typingUntil = 0;
  private quietTimer: number | undefined;
  private hoverTimer: number | undefined;
  private leaveTimer: number | undefined;
  private cursorTimer: number | undefined;
  private card: HTMLElement | null = null;
  private cardMentions: LinkMention[] = [];
  private readonly overrides = new Map<string, number>();
  private readonly checks = new Map<string, Check>();
  private readonly feedback = new Map<string, string>();
  private readonly unsubscribe: () => void;
  private readonly scrolled = () => this.closeCard();
  private readonly keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && this.card) { this.closeCard(); event.stopPropagation(); } };
  private scheduled = false;
  private builtKey = '';
  private alive = true;
  constructor(readonly view: EditorView, private readonly controller: OrganizerController, private readonly host: LinkHintHost, private readonly release: () => void, private readonly focused: (hint: LinkHintView) => void) {
    this.decorations = this.build(); this.builtKey = this.key();
    this.unsubscribe = controller.subscribe(() => this.requestRefresh());
    view.scrollDOM.addEventListener('scroll', this.scrolled, { passive: true });
  }
  private get session() { return this.host.sessionId(this.view); }
  private style() { return this.controller.settings().linkHints; }
  private scan(): LinkMention[] {
    const session = this.session;
    if (!session || this.style() === 'off' || this.view.composing) return [];
    const head = this.view.state.selection.main.head, typing = Date.now() < this.typingUntil;
    // While typing, only the word under the caret waits; everything else updates live.
    return this.controller.scanLinks(session, this.view.visibleRanges).filter(mention => !(typing && mention.from <= head && head <= mention.to));
  }
  private build(): DecorationSet {
    this.mentions = this.scan();
    const ranges: Range<Decoration>[] = [];
    if (this.style() === 'underline') {
      for (const mention of this.mentions) ranges.push(Decoration.mark({ class: 'note-organizer-link-hint ' + (settled(mention) ? 'is-confident' : 'is-uncertain'), attributes: { [ATTRIBUTE]: idOf(mention) } }).range(mention.from, mention.to));
    } else {
      const lines = new Map<number, string[]>();
      for (const mention of this.mentions) { const line = this.view.state.doc.lineAt(mention.from).to; lines.set(line, [...lines.get(line) ?? [], idOf(mention)]); }
      for (const [at, ids] of [...lines].sort((a, b) => a[0] - b[0])) ranges.push(Decoration.widget({ widget: new MarkerWidget(ids), side: 1 }).range(at));
    }
    return Decoration.set(ranges, true);
  }
  /** What the decorations depend on; controller events that leave it unchanged cost no editor transaction. */
  private key(): string { return JSON.stringify([this.style(), this.scan().map(mention => [idOf(mention), mention.verdictKey, mention.tier, mention.verified ?? null])]); }
  private requestRefresh(): void {
    if (this.scheduled || !this.alive) return; this.scheduled = true;
    // Controller events can fire inside an editor update; dispatch afterwards.
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.alive && this.view.dom.isConnected && (this.key() !== this.builtKey || this.card)) this.view.dispatch({ effects: refresh.of(null) });
    });
  }
  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.typingUntil = Date.now() + QUIET_MS; this.closeCard();
      this.checks.clear(); this.overrides.clear(); this.feedback.clear();
      window.clearTimeout(this.quietTimer); this.quietTimer = window.setTimeout(() => this.requestRefresh(), QUIET_MS + 10);
    }
    const refreshed = update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refresh)));
    if (update.docChanged || update.viewportChanged || refreshed || update.focusChanged) {
      this.decorations = this.build(); this.builtKey = this.key();
      // Moving focus to a card action must preserve the button through mouseup.
      if (this.card && refreshed) this.renderCard();
    }
    if (update.focusChanged && this.view.hasFocus) this.focused(this);
    if (update.focusChanged && !this.view.hasFocus) window.clearTimeout(this.cursorTimer);
    if (update.selectionSet && !update.docChanged) this.watchCursor();
  }
  private idsAt(target: EventTarget | null): string[] {
    const element = isNode(target) && target.nodeType === 1 ? (target as Element).closest(`[${ATTRIBUTE}]`) : null;
    return element ? (element.getAttribute(ATTRIBUTE) ?? '').split(' ').filter(Boolean) : [];
  }
  hover(event: MouseEvent): void {
    const ids = this.idsAt(event.target);
    if (!ids.length) return;
    window.clearTimeout(this.leaveTimer); window.clearTimeout(this.hoverTimer);
    const element = (event.target as Element).closest(`[${ATTRIBUTE}]`)!;
    this.hoverTimer = window.setTimeout(() => this.openCard(ids, element.getBoundingClientRect()), HOVER_MS);
  }
  leave(event: MouseEvent): void {
    if (!this.idsAt(event.target).length) return;
    window.clearTimeout(this.hoverTimer);
    if (this.card && isNode(event.relatedTarget) && this.card.contains(event.relatedTarget)) return;
    this.leaveTimer = window.setTimeout(() => this.closeCard(), LEAVE_MS);
  }
  private watchCursor(): void {
    window.clearTimeout(this.cursorTimer);
    if (!this.view.hasFocus || this.style() !== 'underline') return;
    this.cursorTimer = window.setTimeout(() => {
      if (!this.alive || !this.view.hasFocus || this.style() !== 'underline') return;
      const mention = this.atCursor();
      if (!mention) { if (this.card && !this.card.matches(':hover')) this.closeCard(); return; }
      this.openAt(mention);
    }, CURSOR_MS);
  }
  private openAt(mention: LinkMention): void {
    const start = this.view.coordsAtPos(mention.from), end = this.view.coordsAtPos(mention.to);
    if (start && end) this.openCard([idOf(mention)], { left: start.left, bottom: Math.max(start.bottom, end.bottom) });
  }
  private atCursor(): LinkMention | undefined {
    const head = this.view.state.selection.main.head;
    return this.mentions.find(mention => mention.from <= head && head <= mention.to);
  }
  targetAtCursor(): CursorTarget | null {
    const session = this.session;
    if (!session) return null;
    const head = this.view.state.selection.main.head, line = this.view.state.doc.lineAt(head), found = linkAt(line.text, head - line.from);
    if (found) return { kind: 'link', session, link: { ...found, from: found.from + line.from, to: found.to + line.from } };
    const mention = this.atCursor();
    return mention ? { kind: 'mention', session, mention } : null;
  }
  acceptAtCursor(checking: boolean): boolean {
    const mention = this.atCursor();
    if (!mention) return false;
    if (checking) return true;
    // Confident mentions link at once; uncertain ones open the card, which asks the model.
    if (settled(mention)) this.link(mention, mention.verified ?? mention.candidates[0]!.target.noteId); else this.openAt(mention);
    return true;
  }
  private openCard(ids: readonly string[], rect: { left: number; bottom: number }): void {
    if (!this.alive) return;
    const mentions = this.mentions.filter(mention => ids.includes(idOf(mention)));
    if (!mentions.length) return;
    const doc = this.view.dom.ownerDocument;
    if (!this.card) {
      this.card = node(doc.body, 'div', undefined, 'note-organizer note-organizer-hint-card'); this.card.setAttribute('role', 'dialog'); this.card.setAttribute('aria-label', t('hint.label'));
      this.card.addEventListener('mouseleave', () => { this.leaveTimer = window.setTimeout(() => this.closeCard(), LEAVE_MS); });
      this.card.addEventListener('mouseenter', () => window.clearTimeout(this.leaveTimer));
      doc.addEventListener('keydown', this.keydown, true);
    }
    this.cardMentions = mentions; this.renderCard();
    for (const mention of mentions) this.verify(mention);
    const card = this.card;
    if (!card) return;
    const width = Math.min(320, doc.documentElement.clientWidth - 16);
    card.style.left = Math.max(8, Math.min(rect.left, doc.documentElement.clientWidth - width - 8)) + 'px';
    card.style.top = rect.bottom + 6 + 'px'; card.style.maxWidth = width + 'px';
  }
  private verify(mention: LinkMention): void {
    const key = mention.verdictKey, session = this.session, previous = this.checks.get(key);
    if (settled(mention) || (previous && previous.state !== 'failed') || !session || !this.controller.settings().verifyOnHover) return;
    const pending: Check = { state: 'pending' };
    this.checks.set(key, pending); this.renderCard();
    const finish = (result: Check) => {
      if (!this.alive || this.checks.get(key) !== pending) return;
      this.checks.set(key, result); this.renderCard();
    };
    void this.controller.verifyLink(session, mention).then(selected => finish({ state: 'done', selected }), error => finish({ state: 'failed', message: errorText(error) }));
  }
  private renderCard(): void {
    const card = this.card; if (!card) return;
    if (this.style() === 'off') { this.closeCard(); return; }
    this.cardMentions = this.cardMentions.flatMap(mention => {
      const current = this.mentions.find(item => item.verdictKey === mention.verdictKey);
      if (current) return [current];
      const check = this.checks.get(mention.verdictKey), session = this.session;
      // Keep a rejected answer visible only while its source and candidates still match.
      if (session && (check?.state === 'pending' || (check?.state === 'done' && check.selected === null))) {
        try { this.controller.linkProposalFor(session, mention); return [mention]; } catch { /* The card became stale. */ }
      }
      return [];
    });
    if (!this.cardMentions.length) { this.closeCard(); return; }
    card.replaceChildren();
    for (const mention of this.cardMentions) this.renderMention(card, mention);
  }
  private renderMention(card: HTMLElement, mention: LinkMention): void {
    const id = mention.verdictKey, check = this.checks.get(id), row = node(card, 'div', undefined, 'note-organizer-hint-row');
    const verdict = check?.state === 'done' && check.selected !== null ? check.selected : undefined;
    const chosen = this.overrides.get(id) ?? mention.verified ?? verdict ?? (mention.tier === 'confident' ? mention.candidates[0]?.target.noteId : undefined);
    const target = mention.candidates.find(candidate => candidate.target.noteId === chosen)?.target;
    // A card for several mentions (line marker) names each one; otherwise the underlined word is right above.
    if (this.cardMentions.length > 1) node(row, 'div', `“${mention.text}”`, 'note-organizer-hint-label');
    const head = node(row, 'div', undefined, 'note-organizer-hint-head');
    if (target) node(head, 'div', target.title, 'note-organizer-hint-title note-organizer-hint-target');
    else {
      const status = check?.state === 'pending' ? t('hint.checking') : check?.state === 'done' ? t('hint.noLink') : check?.state === 'failed' ? check.message : t('hint.choose');
      const message = node(head, 'div', status, 'note-organizer-hint-status' + (check?.state === 'pending' ? ' is-pending' : '')); message.setAttribute('role', 'status');
    }
    const tools = node(head, 'div', undefined, 'note-organizer-hint-tools');
    if (target) {
      button(tools, t('hint.link'), () => this.link(mention, target.noteId), true).classList.add('note-organizer-hint-accept');
      if (mention.candidates.length > 1) this.iconButton(tools, 'arrow-left-right', t('hint.other'), () => this.host.chooseTarget(mention.candidates.map(candidate => candidate.target), noteId => { if (this.alive && this.cardMentions.some(item => item.verdictKey === id)) { this.overrides.set(id, noteId); this.renderCard(); } }));
    }
    this.iconButton(tools, 'x', t('hint.ignore'), () => this.ignore(mention));
    this.iconButton(tools, 'eye-off', t('hint.never', { term: mention.text }), () => { void this.controller.ignoreLinkTerm(mention.text).catch(() => undefined); this.closeCard(); });
    const meta = target && [folderOf(target.path), target.description].filter(Boolean).join(' · ');
    if (meta) node(row, 'div', meta, 'note-organizer-hint-meta note-organizer-hint-about');
    if (!target) {
      // Picking a candidate is the confirmation: it links at once.
      const options = node(row, 'div', undefined, 'note-organizer-hint-options');
      for (const candidate of mention.candidates.slice(0, 4)) {
        const option = button(options, '', () => this.link(mention, candidate.target.noteId)); option.className = 'note-organizer-hint-option';
        node(option, 'span', candidate.target.title, 'note-organizer-hint-title');
        const folder = folderOf(candidate.target.path); if (folder) node(option, 'span', folder, 'note-organizer-hint-meta');
        option.setAttribute('aria-label', t('linkMenu.link', { path: breadcrumb(candidate.target.path) }));
      }
    }
    const problem = this.feedback.get(id);
    if (problem) { const status = node(row, 'p', problem, 'note-organizer-feedback'); status.setAttribute('role', 'status'); }
  }
  private iconButton(parent: HTMLElement, icon: string, label: string, action: () => void): HTMLButtonElement {
    const control = button(parent, '', action); control.className = 'note-organizer-icon-button';
    setIcon(control, icon); control.setAttribute('aria-label', label); setTooltip(control, label, { placement: 'top' });
    return control;
  }
  private link(mention: LinkMention, targetId: number): void {
    const id = mention.verdictKey, session = this.session;
    this.feedback.delete(id);
    try {
      if (!session) return;
      const proposal = this.controller.linkProposalFor(session, mention, targetId);
      const result = this.controller.confirmLinks([this.controller.prepareLink(proposal, targetId)]);
      const failure = result.failures[0];
      if (failure) throw failure.error;
      this.overrides.delete(id); this.closeCard();
    } catch (error) { this.feedback.set(id, errorText(error)); this.renderCard(); }
  }
  private ignore(mention: LinkMention): void {
    const session = this.session;
    if (!session) return;
    try { this.controller.dismissLink(this.controller.linkProposalFor(session, mention)); } catch (error) { this.feedback.set(mention.verdictKey, errorText(error)); }
    this.cardMentions = this.cardMentions.filter(item => idOf(item) !== idOf(mention)); this.renderCard();
  }
  private closeCard(): void {
    window.clearTimeout(this.hoverTimer); window.clearTimeout(this.leaveTimer); window.clearTimeout(this.cursorTimer);
    if (!this.card) return;
    this.view.dom.ownerDocument.removeEventListener('keydown', this.keydown, true);
    this.card.remove(); this.card = null; this.cardMentions = [];
  }
  destroy(): void {
    this.alive = false; this.closeCard(); this.unsubscribe(); this.release();
    window.clearTimeout(this.quietTimer);
    this.view.scrollDOM.removeEventListener('scroll', this.scrolled);
  }
}
