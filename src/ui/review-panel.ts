import type { OrganizerController } from './types';
import type { FilingEntry, MovePlan } from '../filing/types';
import type { LinkProposal, LinkPlan } from '../linking/types';
import { button, details, node } from './dom';
import { messageFor } from '../core/errors';
import type { Unsubscribe } from '../core/events';

export interface ReviewActions { settings(): void; folder(choose: (id: string) => void): void; target(proposal: LinkProposal, choose: (id: number) => void): void }
interface Card { element: HTMLElement; signature: string }
export class ReviewPanel {
  private mode: 'current' | 'inbox';
  private readonly cards = new Map<string, Card>();
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly pending: HTMLDetailsElement;
  private readonly tabs: Record<'current' | 'inbox', HTMLButtonElement>;
  private readonly unsubscribe: Unsubscribe;
  private limit = 20;
  private alive = true;
  private shownPath: string | null = null;
  private footerSignature = '';
  constructor(private readonly container: HTMLElement, private readonly controller: OrganizerController, private readonly actions: ReviewActions) {
    container.classList.add('note-organizer');
    this.mode = controller.state().links.length ? 'current' : 'inbox';
    const head = node(container, 'div', undefined, 'note-organizer-head'); node(head, 'strong', '整理'); button(head, '设置', () => actions.settings());
    const tabs = node(container, 'div', undefined, 'note-organizer-tabs');
    this.tabs = { current: button(tabs, '当前笔记', () => this.select('current')), inbox: button(tabs, '收件箱', () => this.select('inbox')) };
    this.status = node(container, 'p', '', 'note-organizer-muted');
    this.list = node(container, 'div', undefined, 'note-organizer-list');
    this.pending = details(this.list, '尚未确定位置');
    this.unsubscribe = controller.subscribe(() => this.render()); this.render();
  }
  private select(mode: 'current' | 'inbox'): void { this.mode = mode; this.cards.clear(); this.list.replaceChildren(this.pending); this.pending.replaceChildren(); node(this.pending, 'summary', '尚未确定位置'); this.render(); }
  showCurrent(): void { this.select('current'); }
  private render(): void {
    if (!this.alive) return;
    const state = this.controller.state();
    if (this.mode === 'current' && this.shownPath !== state.activePath) { this.cards.clear(); this.list.replaceChildren(this.pending); }
    this.shownPath = state.activePath;
    for (const mode of ['current', 'inbox'] as const) this.tabs[mode].setAttribute('aria-pressed', String(this.mode === mode));
    this.status.textContent = state.network.reason || (this.mode === 'current' ? state.message || (state.indexReady ? '需要时确认一处链接。' : '正在准备笔记索引…') : '准备好时再整理。关闭面板，笔记会留在原处。');
    if (!this.controller.settings().secretName || !this.controller.settings().inbox) {
      this.list.replaceChildren(); this.cards.clear(); node(this.list, 'p', '选择收件箱和 Jev 连接后，即可准备整理建议。'); button(this.list, '设置整理', () => this.actions.settings()); return;
    }
    if (!this.list.contains(this.pending)) this.list.append(this.pending);
    const entries = this.mode === 'inbox' ? state.filing.filter(entry => entry.status !== 'ignored').slice(0, this.limit) : state.links;
    this.pending.hidden = this.mode !== 'inbox' || !entries.some(entry => 'status' in entry && ['waiting', 'unassigned'].includes(entry.status));
    const ids = new Set<string>();
    for (const entry of entries) {
      const filing = 'status' in entry, key = filing ? entry.path : entry.id;
      ids.add(key);
      const signature = JSON.stringify(entry);
      let card = this.cards.get(key);
      const parent = filing && ['waiting', 'unassigned'].includes(entry.status) ? this.pending : this.list;
      if (!card) { card = { element: node(parent, 'section', undefined, 'note-organizer-card'), signature: '' }; if (parent === this.list) parent.insertBefore(card.element, this.pending); this.cards.set(key, card); }
      else if (card.element.parentElement !== parent && !card.element.contains(containerActive(this.container))) { if (parent === this.list) parent.insertBefore(card.element, this.pending); else parent.append(card.element); }
      if (card.signature === signature) continue;
      const current = card;
      const update = () => { if (!this.alive) return; current.signature = signature; current.element.replaceChildren(); if (filing) this.filing(current.element, entry); else this.link(current.element, entry); };
      if (current.element.contains(containerActive(this.container)) && current.signature && !(filing && ['moving', 'done', 'failed', 'review'].includes(entry.status))) {
        current.element.querySelectorAll('button').forEach(control => { control.disabled = true; });
        current.element.addEventListener('focusout', update, { once: true });
      } else update();
    }
    for (const [key, card] of this.cards) if (!ids.has(key)) {
      if (card.element.dataset.completed === 'true' && this.mode === 'current') continue;
      card.element.remove(); this.cards.delete(key);
    }
    const previousFooter = this.list.querySelector<HTMLElement>('.note-organizer-footer');
    const recentMoves = this.controller.recentMoves().slice(-20).reverse();
    const footerSignature = JSON.stringify([this.mode, state.links.length > 0, state.filing.length > this.limit, recentMoves]);
    if (previousFooter && this.footerSignature === footerSignature) return;
    if (previousFooter?.contains(containerActive(this.container))) {
      if (!previousFooter.dataset.refresh) { previousFooter.dataset.refresh = 'pending'; previousFooter.addEventListener('focusout', () => { delete previousFooter.dataset.refresh; this.render(); }, { once: true }); }
      return;
    }
    this.footerSignature = footerSignature;
    previousFooter?.remove();
    const footer = node(this.list, 'div', undefined, 'note-organizer-footer');
    if (this.mode === 'current') button(footer, state.links.length ? '重新查找' : '查找链接', () => { void this.run(footer, () => this.controller.findLinks()); });
    else {
      button(footer, '分析已有笔记', () => this.controller.analyzeInbox());
      if (state.filing.length > this.limit) button(footer, '显示更多', () => { this.limit += 20; this.render(); });
      const recent = details(footer, '最近操作');
      for (const record of recentMoves) {
        const row = node(recent, 'div', undefined, 'note-organizer-recent'); node(row, 'span', record.to);
        if (record.status === 'done') button(row, '撤销', () => { void this.run(row, () => this.controller.undoMove(record.id)); });
        else node(row, 'p', record.status === 'review' || record.status === 'intent' ? record.message || '请核对笔记当前位置。' : '已撤销', 'note-organizer-muted');
      }
    }
  }
  private filing(row: HTMLElement, entry: FilingEntry): void {
    button(row, entry.path.slice(entry.path.lastIndexOf('/') + 1), () => this.controller.openNote(entry.status === 'done' ? this.controller.recentMoves().find(record => record.id === entry.moveRecordId)?.to ?? entry.path : entry.path));
    if (entry.status === 'done') { node(row, 'p', '已归档'); if (entry.moveRecordId) button(row, '撤销', () => { void this.run(row, () => this.controller.undoMove(entry.moveRecordId!)); }); return; }
    if (entry.status === 'review') { node(row, 'p', entry.message || '请核对笔记当前位置。'); return; }
    if (entry.status === 'analyzing' || entry.status === 'moving') { node(row, 'p', entry.status === 'moving' ? '正在归档…' : '正在准备建议…', 'note-organizer-muted'); return; }
    const destination = node(row, 'p', entry.message ?? '', 'note-organizer-path');
    const controls = node(row, 'div', undefined, 'note-organizer-actions');
    let plan: MovePlan | null = null;
    let preparation = 0;
    const confirm = button(controls, '归档', () => { if (!plan) return; row.style.minHeight = row.getBoundingClientRect().height + 'px'; confirm.disabled = true; const shown = plan; void this.run(row, async () => { await this.controller.confirmMove(shown); row.replaceChildren(); node(row, 'p', '已归档'); node(row, 'p', shown.destination, 'note-organizer-path'); button(row, '撤销', () => { void this.run(row, () => this.controller.undoMove(shown.id)); }); }); }, true);
    confirm.disabled = true; confirm.hidden = true;
    const prepare = async (id: string) => {
      const request = ++preparation;
      plan = null; confirm.disabled = true;
      const target = this.controller.folders().find(folder => folder.id === id);
      destination.textContent = target ? '建议移到 ' + target.path + '/' + entry.path.slice(entry.path.lastIndexOf('/') + 1) : '请选择位置。';
      try { const value = await this.controller.prepareMove(entry.path, id); if (request !== preparation || !row.isConnected || !this.alive) return; plan = value; destination.textContent = '建议移到 ' + value.destination; confirm.hidden = false; confirm.disabled = false; }
      catch (error) { if (request === preparation) destination.textContent = messageFor(error); }
    };
    if (entry.proposal?.selected) void prepare(entry.proposal.selected);
    else { destination.textContent ||= entry.status === 'unassigned' ? '尚未确定位置。' : '需要时分析这篇笔记。'; button(controls, '分析', () => this.controller.analyzeNote(entry.path)); }
    button(controls, entry.proposal?.selected ? '更改位置' : '选择位置', () => this.actions.folder(id => { void prepare(id); }));
    const more = details(row, '更多'); button(more, '不再建议这篇', () => this.controller.ignoreNote(entry.path));
  }
  private link(row: HTMLElement, proposal: LinkProposal): void {
    const anchor = proposal.input.anchor;
    const start = Math.max(0, anchor.from - anchor.contextFrom - 30), end = Math.min(anchor.contextText.length, anchor.to - anchor.contextFrom + 60);
    node(row, 'blockquote', '“' + (start ? '…' : '') + anchor.contextText.slice(start, end) + (end < anchor.contextText.length ? '…' : '') + '”');
    const destination = node(row, 'div', undefined, 'note-organizer-path');
    let plan: LinkPlan | null = null;
    const controls = node(row, 'div', undefined, 'note-organizer-actions');
    const confirm = button(controls, '添加链接', () => {
      if (!plan) return; row.style.minHeight = row.getBoundingClientRect().height + 'px'; confirm.disabled = true; row.dataset.completed = 'true';
      try { this.controller.confirmLink(plan); row.replaceChildren(); node(row, 'p', '已添加链接 · 可用编辑器撤销'); }
      catch (error) { row.dataset.completed = 'false'; this.feedback(row, messageFor(error)); }
    }, true);
    const prepare = (id: number) => {
      try { plan = this.controller.prepareLink(proposal, id); destination.replaceChildren(); button(destination, plan.target.path, () => this.controller.openNote(plan!.target.path)); confirm.disabled = false; }
      catch (error) { plan = null; confirm.disabled = true; destination.textContent = messageFor(error); }
    };
    if (proposal.selected !== null) prepare(proposal.selected);
    button(controls, '更换目标', () => this.actions.target(proposal, prepare));
    const more = details(row, '更多'); button(more, '本次不再提示', () => this.controller.dismissLink(proposal));
  }
  private feedback(row: HTMLElement, message: string): void { let status = row.querySelector<HTMLElement>('.note-organizer-feedback'); if (!status) { status = node(row, 'p', '', 'note-organizer-feedback'); status.setAttribute('role', 'status'); } status.textContent = message; }
  private async run(row: HTMLElement, action: () => Promise<void>): Promise<void> { try { await action(); } catch (error) { this.feedback(row, messageFor(error)); } }
  destroy(): void { this.alive = false; this.unsubscribe(); this.cards.clear(); }
}
function containerActive(container: HTMLElement): Element | null { return container.ownerDocument.activeElement; }
