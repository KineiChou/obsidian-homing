import { setIcon } from 'obsidian';
import { StateEffect, type Extension, type Range } from '@codemirror/state';
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import type { OrganizerController } from './types';
import type { LinkProposal } from '../linking/types';
import { button, node } from './dom';
import { errorText, t } from '../i18n';

export interface LinkHintHost {
  sessionId(view: EditorView): string | undefined;
  chooseTarget(proposal: LinkProposal, choose: (noteId: number) => void): void;
}
export interface LinkHints { readonly extension: Extension; acceptAtCursor(checking?: boolean): boolean }

/** Hints stay hidden while typing and appear only after this pause. */
export const QUIET_MS = 1500;
const HOVER_MS = 300, CURSOR_MS = 700, LEAVE_MS = 250;
const refresh = StateEffect.define<null>();
const ATTRIBUTE = 'data-note-organizer-proposals';
const breadcrumb = (path: string) => path.replace(/\.md$/, '').split('/').join(' › ');
// Popout editors can send DOM nodes from another window's realm.
const isNode = (value: EventTarget | null): value is Node => !!value && 'nodeType' in value;

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
  private quietUntil = 0;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private leaveTimer: ReturnType<typeof setTimeout> | undefined;
  private cursorTimer: ReturnType<typeof setTimeout> | undefined;
  private card: HTMLElement | null = null;
  private cardIds: readonly string[] = [];
  private readonly overrides = new Map<string, number>();
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
  private proposals(): LinkProposal[] {
    const session = this.host.sessionId(this.view), doc = this.view.state.doc;
    if (!session) return [];
    return this.controller.linkSuggestions().filter(proposal => {
      const anchor = proposal.input.anchor;
      return proposal.selected !== null && anchor.editorSessionId === session && anchor.to <= doc.length && doc.sliceString(anchor.from, anchor.to) === anchor.originalText;
    });
  }
  private style() { return this.controller.settings().linkHints; }
  private build(): DecorationSet {
    const style = this.style();
    if (style === 'off' || this.view.composing || Date.now() < this.quietUntil) return Decoration.none;
    const proposals = this.proposals().sort((a, b) => a.input.anchor.from - b.input.anchor.from);
    const ranges: Range<Decoration>[] = [];
    if (style === 'underline') {
      let end = -1;
      for (const proposal of proposals) {
        const { from, to } = proposal.input.anchor;
        if (from < end) continue; end = to;
        ranges.push(Decoration.mark({ class: 'note-organizer-link-hint', attributes: { [ATTRIBUTE]: proposal.id } }).range(from, to));
      }
    } else {
      const lines = new Map<number, string[]>();
      for (const proposal of proposals) { const line = this.view.state.doc.lineAt(proposal.input.anchor.from).to; lines.set(line, [...lines.get(line) ?? [], proposal.id]); }
      for (const [at, ids] of [...lines].sort((a, b) => a[0] - b[0])) ranges.push(Decoration.widget({ widget: new MarkerWidget(ids), side: 1 }).range(at));
    }
    return Decoration.set(ranges, true);
  }
  /** What the decorations depend on; controller events that leave it unchanged cost no editor transaction. */
  private key(): string {
    const quiet = this.view.composing || Date.now() < this.quietUntil;
    return JSON.stringify([this.style(), quiet, this.proposals().map(proposal => [proposal.id, proposal.input.anchor.from, proposal.input.anchor.to])]);
  }
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
      this.quietUntil = Date.now() + QUIET_MS; this.closeCard();
      clearTimeout(this.quietTimer); this.quietTimer = setTimeout(() => this.requestRefresh(), QUIET_MS + 10);
    }
    const refreshed = update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refresh)));
    if (update.docChanged || refreshed || update.focusChanged) {
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
      const proposal = this.atCursor();
      if (!proposal || this.decorations.size === 0) { if (this.card && !this.card.matches(':hover')) this.closeCard(); return; }
      const start = this.view.coordsAtPos(proposal.input.anchor.from), end = this.view.coordsAtPos(proposal.input.anchor.to);
      if (start && end) this.openCard([proposal.id], { left: start.left, bottom: Math.max(start.bottom, end.bottom) });
    }, CURSOR_MS);
  }
  private atCursor(): LinkProposal | undefined {
    const head = this.view.state.selection.main.head;
    return this.proposals().find(proposal => proposal.input.anchor.from <= head && head <= proposal.input.anchor.to);
  }
  acceptAtCursor(checking: boolean): boolean {
    const proposal = this.atCursor();
    if (!proposal) return false;
    if (!checking) this.link(proposal);
    return true;
  }
  private openCard(ids: readonly string[], rect: { left: number; bottom: number }): void {
    if (!this.alive) return;
    const doc = this.view.dom.ownerDocument;
    if (!this.card) {
      this.card = node(doc.body, 'div', undefined, 'note-organizer note-organizer-hint-card'); this.card.setAttribute('role', 'dialog'); this.card.setAttribute('aria-label', t('hint.label'));
      this.card.addEventListener('mouseleave', () => { this.leaveTimer = setTimeout(() => this.closeCard(), LEAVE_MS); });
      this.card.addEventListener('mouseenter', () => clearTimeout(this.leaveTimer));
      doc.addEventListener('keydown', this.keydown, true);
    }
    this.cardIds = ids; this.renderCard();
    const card = this.card;
    if (!card) return;
    const width = Math.min(320, doc.documentElement.clientWidth - 16);
    card.style.left = Math.max(8, Math.min(rect.left, doc.documentElement.clientWidth - width - 8)) + 'px';
    card.style.top = rect.bottom + 6 + 'px'; card.style.width = width + 'px';
  }
  private renderCard(): void {
    const card = this.card; if (!card) return;
    const proposals = this.proposals().filter(proposal => this.cardIds.includes(proposal.id));
    if (!proposals.length) { this.closeCard(); return; }
    card.replaceChildren();
    for (const proposal of proposals) {
      const row = node(card, 'div', undefined, 'note-organizer-hint-row');
      const targetId = this.overrides.get(proposal.id) ?? proposal.selected!, target = proposal.input.candidates.find(candidate => candidate.noteId === targetId);
      const title = node(row, 'div', undefined, 'note-organizer-hint-title'); setIcon(node(title, 'span'), 'link'); node(title, 'span', target?.title ?? proposal.input.anchor.originalText);
      if (target) node(row, 'div', breadcrumb(target.path) + (target.description ? ' · ' + target.description : ''), 'note-organizer-muted');
      const actions = node(row, 'div', undefined, 'note-organizer-actions');
      button(actions, t('hint.link'), () => this.link(proposal), true);
      if (proposal.input.candidates.length > 1) button(actions, t('hint.other'), () => this.host.chooseTarget(proposal, noteId => { this.overrides.set(proposal.id, noteId); this.renderCard(); }));
      button(actions, t('hint.ignore'), () => { this.controller.dismissLink(proposal); });
      const message = this.feedback.get(proposal.id);
      if (message) { const status = node(row, 'p', message, 'note-organizer-feedback'); status.setAttribute('role', 'status'); }
    }
  }
  private link(proposal: LinkProposal): void {
    this.feedback.delete(proposal.id);
    try {
      const plan = this.controller.prepareLink(proposal, this.overrides.get(proposal.id) ?? proposal.selected!);
      const result = this.controller.confirmLinks([plan]);
      const failure = result.failures[0];
      if (failure) throw failure.error;
      this.overrides.delete(proposal.id);
    } catch (error) { this.feedback.set(proposal.id, errorText(error)); }
    this.renderCard();
  }
  private closeCard(): void {
    clearTimeout(this.hoverTimer); clearTimeout(this.leaveTimer); clearTimeout(this.cursorTimer);
    if (!this.card) return;
    this.view.dom.ownerDocument.removeEventListener('keydown', this.keydown, true);
    this.card.remove(); this.card = null; this.cardIds = [];
  }
  destroy(): void {
    this.alive = false; this.closeCard(); this.unsubscribe(); this.release();
    for (const timer of [this.quietTimer, this.cursorTimer]) clearTimeout(timer);
    this.view.scrollDOM.removeEventListener('scroll', this.scrolled);
  }
}
