import { setIcon } from 'obsidian';
import { StateEffect, type Extension, type Range } from '@codemirror/state';
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import type { LinkMention, OrganizerController } from './types';
import type { LinkTarget } from '../linking/types';
import { button, node } from './dom';
import { errorText, t } from '../i18n';

export interface LinkHintHost {
  sessionId(view: EditorView): string | undefined;
  chooseTarget(candidates: readonly LinkTarget[], choose: (noteId: number) => void): void;
}
export interface LinkHints { readonly extension: Extension; acceptAtCursor(checking?: boolean): boolean }

/** After an edit, the mention under the caret stays undecorated for this long (docs/link-matching.md §7). */
export const QUIET_MS = 1500;
const HOVER_MS = 300, CURSOR_MS = 700, LEAVE_MS = 250;
const refresh = StateEffect.define<null>();
const ATTRIBUTE = 'data-note-organizer-mentions';
const breadcrumb = (path: string) => path.replace(/\.md$/, '').split('/').join(' › ');
const idOf = (mention: { from: number; to: number }) => `${mention.from}:${mention.to}`;
const settled = (mention: LinkMention) => mention.tier === 'confident' || mention.verified !== undefined;
// Popout editors can send DOM nodes from another window's realm.
const isNode = (value: EventTarget | null): value is Node => !!value && 'nodeType' in value;
type Check = { state: 'pending' } | { state: 'done'; selected: number | null } | { state: 'failed'; message: string };

class MarkerWidget extends WidgetType {
  constructor(private readonly ids: readonly string[]) { super(); }
  eq(other: MarkerWidget): boolean { return other.ids.join() === this.ids.join(); }
  toDOM(view: EditorView): HTMLElement {
    const marker = view.dom.ownerDocument.createElement('span'); marker.className = 'note-organizer-link-marker';
    marker.setAttribute(ATTRIBUTE, this.ids.join(' ')); marker.setAttribute('aria-label', t('hint.marker', { count: this.ids.length }));
    setIcon(marker, 'link'); return marker;
  }
  ignoreEvent(): boolean { return false; }
}

/** Local, network-free link hints; the model is asked only for uncertain mentions, on hover. */
export function linkHints(controller: OrganizerController, host: LinkHintHost): LinkHints {
  const views = new Set<LinkHintView>();
  const extension = ViewPlugin.define(view => { const hint: LinkHintView = new LinkHintView(view, controller, host, () => views.delete(hint)); views.add(hint); return hint; }, {
    decorations: value => value.decorations,
    eventHandlers: {
      mouseover(event) { this.hover(event); },
      mouseout(event) { this.leave(event); },
    },
  });
  return {
    extension,
    acceptAtCursor: (checking = false) => {
      const hint = [...views].find(item => item.view.hasFocus);
      return hint ? hint.acceptAtCursor(checking) : false;
    },
  };
}

class LinkHintView {
  decorations: DecorationSet = Decoration.none;
  private mentions: LinkMention[] = [];
  private typingUntil = 0;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private leaveTimer: ReturnType<typeof setTimeout> | undefined;
  private cursorTimer: ReturnType<typeof setTimeout> | undefined;
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
  constructor(readonly view: EditorView, private readonly controller: OrganizerController, private readonly host: LinkHintHost, private readonly release: () => void) {
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
  private key(): string { return JSON.stringify([this.style(), this.scan().map(mention => [idOf(mention), mention.tier, mention.verified ?? null])]); }
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
      clearTimeout(this.quietTimer); this.quietTimer = setTimeout(() => this.requestRefresh(), QUIET_MS + 10);
    }
    const refreshed = update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refresh)));
    if (update.docChanged || update.viewportChanged || refreshed || update.focusChanged) {
      this.decorations = this.build(); this.builtKey = this.key();
      // Moving focus to a card action must preserve the button through mouseup.
      if (this.card && refreshed) this.renderCard();
    }
    if (update.focusChanged && !this.view.hasFocus) clearTimeout(this.cursorTimer);
    if (update.selectionSet && !update.docChanged) this.watchCursor();
  }
  private idsAt(target: EventTarget | null): string[] {
    const element = isNode(target) && target.nodeType === 1 ? (target as Element).closest(`[${ATTRIBUTE}]`) : null;
    return element ? (element.getAttribute(ATTRIBUTE) ?? '').split(' ').filter(Boolean) : [];
  }
  hover(event: MouseEvent): void {
    const ids = this.idsAt(event.target);
    if (!ids.length) return;
    clearTimeout(this.leaveTimer); clearTimeout(this.hoverTimer);
    const element = (event.target as Element).closest(`[${ATTRIBUTE}]`)!;
    this.hoverTimer = setTimeout(() => this.openCard(ids, element.getBoundingClientRect()), HOVER_MS);
  }
  leave(event: MouseEvent): void {
    if (!this.idsAt(event.target).length) return;
    clearTimeout(this.hoverTimer);
    if (this.card && isNode(event.relatedTarget) && this.card.contains(event.relatedTarget)) return;
    this.leaveTimer = setTimeout(() => this.closeCard(), LEAVE_MS);
  }
  private watchCursor(): void {
    clearTimeout(this.cursorTimer);
    if (!this.view.hasFocus || this.style() !== 'underline') return;
    this.cursorTimer = setTimeout(() => {
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
      this.card.addEventListener('mouseleave', () => { this.leaveTimer = setTimeout(() => this.closeCard(), LEAVE_MS); });
      this.card.addEventListener('mouseenter', () => clearTimeout(this.leaveTimer));
      doc.addEventListener('keydown', this.keydown, true);
    }
    this.cardMentions = mentions; this.renderCard();
    for (const mention of mentions) this.verify(mention);
    const card = this.card;
    if (!card) return;
    const width = Math.min(320, doc.documentElement.clientWidth - 16);
    card.style.left = Math.max(8, Math.min(rect.left, doc.documentElement.clientWidth - width - 8)) + 'px';
    card.style.top = rect.bottom + 6 + 'px'; card.style.width = width + 'px';
  }
  private verify(mention: LinkMention): void {
    const id = idOf(mention), session = this.session;
    if (settled(mention) || this.checks.has(id) || !session || !this.controller.settings().verifyOnHover) return;
    this.checks.set(id, { state: 'pending' }); this.renderCard();
    void this.controller.verifyLink(session, mention).then(selected => { this.checks.set(id, { state: 'done', selected }); }, error => { this.checks.set(id, { state: 'failed', message: errorText(error) }); }).then(() => { if (this.alive) this.renderCard(); });
  }
  private renderCard(): void {
    const card = this.card; if (!card) return;
    // Refresh positions and verdicts from the latest scan; keep a mention the model just rejected so its answer stays visible.
    this.cardMentions = this.cardMentions.map(mention => this.mentions.find(item => idOf(item) === idOf(mention)) ?? mention);
    if (!this.cardMentions.length) { this.closeCard(); return; }
    card.replaceChildren();
    for (const mention of this.cardMentions) this.renderMention(card, mention);
  }
  private renderMention(card: HTMLElement, mention: LinkMention): void {
    const id = idOf(mention), check = this.checks.get(id), row = node(card, 'div', undefined, 'note-organizer-hint-row');
    const verdict = check?.state === 'done' && check.selected !== null ? check.selected : undefined;
    const chosen = this.overrides.get(id) ?? mention.verified ?? verdict ?? (mention.tier === 'confident' ? mention.candidates[0]?.target.noteId : undefined);
    const target = mention.candidates.find(candidate => candidate.target.noteId === chosen)?.target;
    const title = node(row, 'div', undefined, 'note-organizer-hint-title'); setIcon(node(title, 'span'), 'link'); node(title, 'span', target?.title ?? mention.text);
    if (target) {
      node(row, 'div', breadcrumb(target.path) + (target.description ? ' · ' + target.description : ''), 'note-organizer-muted');
      const actions = node(row, 'div', undefined, 'note-organizer-actions');
      button(actions, t('hint.link'), () => this.link(mention, target.noteId), true);
      if (mention.candidates.length > 1) button(actions, t('hint.other'), () => this.host.chooseTarget(mention.candidates.map(candidate => candidate.target), noteId => { this.overrides.set(id, noteId); this.renderCard(); }));
      button(actions, t('hint.ignore'), () => this.ignore(mention));
    } else {
      const status = check?.state === 'pending' ? t('hint.checking') : check?.state === 'done' ? t('hint.noLink') : check?.state === 'failed' ? check.message : t('hint.choose');
      const message = node(row, 'div', status, 'note-organizer-muted'); message.setAttribute('role', 'status');
      const choices = node(row, 'div', undefined, 'note-organizer-hint-choices');
      for (const candidate of mention.candidates.slice(0, 4)) {
        const choice = button(choices, breadcrumb(candidate.target.path), () => { this.overrides.set(id, candidate.target.noteId); this.renderCard(); });
        choice.className = 'note-organizer-chip';
      }
      const actions = node(row, 'div', undefined, 'note-organizer-actions');
      button(actions, t('hint.ignore'), () => this.ignore(mention));
    }
    const never = button(row, t('hint.never', { term: mention.text }), () => { void this.controller.ignoreLinkTerm(mention.text).catch(() => undefined); this.closeCard(); });
    never.className = 'note-organizer-link-button note-organizer-hint-never';
    const problem = this.feedback.get(id);
    if (problem) { const status = node(row, 'p', problem, 'note-organizer-feedback'); status.setAttribute('role', 'status'); }
  }
  private link(mention: LinkMention, targetId: number): void {
    const id = idOf(mention), session = this.session;
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
    try { this.controller.dismissLink(this.controller.linkProposalFor(session, mention)); } catch (error) { this.feedback.set(idOf(mention), errorText(error)); }
    this.cardMentions = this.cardMentions.filter(item => idOf(item) !== idOf(mention)); this.renderCard();
  }
  private closeCard(): void {
    clearTimeout(this.hoverTimer); clearTimeout(this.leaveTimer); clearTimeout(this.cursorTimer);
    if (!this.card) return;
    this.view.dom.ownerDocument.removeEventListener('keydown', this.keydown, true);
    this.card.remove(); this.card = null; this.cardMentions = [];
  }
  destroy(): void {
    this.alive = false; this.closeCard(); this.unsubscribe(); this.release();
    clearTimeout(this.quietTimer);
    this.view.scrollDOM.removeEventListener('scroll', this.scrolled);
  }
}
