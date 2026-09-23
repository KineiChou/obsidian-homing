import type { OrganizerController } from './types';
import type { FilingEntry, MovePlan } from '../filing/types';
import type { Unsubscribe } from '../core/events';
import { button, details, node } from './dom';
import { errorText, t, translateMessage } from '../i18n';

export interface ReviewActions {
  settings(): void;
  folder(choose: (id: string) => void): void;
  analyze(paths?: readonly string[]): void;
  preview(text: string, container: HTMLElement, path: string): Promise<(() => void) | void>;
  menu(anchor: HTMLElement, items: readonly { title: string; run(): void }[]): void;
}
interface Row { element: HTMLElement; open: HTMLButtonElement; check: HTMLInputElement; description: HTMLElement; group: string }
const groupFor = (entry: FilingEntry): string => entry.status === 'ready' ? 'ready' : ['analyzing', 'moving'].includes(entry.status) ? 'analyzing' : entry.status === 'done' ? 'done' : 'waiting';
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
const breadcrumb = (path: string) => path.split('/').join(' › ');

export class ReviewPanel {
  private readonly rows = new Map<string, Row>();
  private readonly groups = new Map<string, HTMLElement>();
  private readonly checked = new Set<string>();
  private readonly unsubscribe: Unsubscribe;
  private readonly list: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly title: HTMLElement;
  private readonly status: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly info: HTMLElement;
  private readonly undoBar: HTMLElement;
  private feedback = '';
  private readonly recent: HTMLDetailsElement;
  private readonly selectedCount: HTMLElement;
  private readonly bulk: HTMLButtonElement;
  private current: string | null = null;
  private selectedDestination: string | null = null;
  private signature = '';
  private previewKey = '';
  private plan: MovePlan | null = null;
  private preparation = 0;
  private previewRequest = 0;
  private previewCleanup: (() => void) | undefined;
  private alive = true;
  private busy = false;
  private acceptAfter = 0;
  private guardTimer: ReturnType<typeof setTimeout> | undefined;
  private lastMove: string | null = null;
  private readonly keydown = (event: KeyboardEvent) => this.onKey(event);
  constructor(private readonly container: HTMLElement, private readonly controller: OrganizerController, private readonly actions: ReviewActions) {
    container.classList.add('note-organizer', 'note-organizer-review'); container.tabIndex = 0;
    const head = node(container, 'header', undefined, 'note-organizer-head'); node(head, 'h2', t('organizer.title'));
    const toolbar = node(head, 'div', undefined, 'note-organizer-actions');
    button(toolbar, t('organizer.settings'), () => actions.settings()); button(toolbar, t('organizer.analyze'), () => actions.analyze());
    this.status = node(container, 'p', '', 'note-organizer-muted'); this.status.setAttribute('role', 'status');
    const layout = node(container, 'div', undefined, 'note-organizer-layout');
    const sidebar = node(layout, 'aside', undefined, 'note-organizer-queue');
    const selection = node(sidebar, 'div', undefined, 'note-organizer-selection');
    this.selectedCount = node(selection, 'span'); this.bulk = button(selection, t('organizer.analyzeSelected'), () => actions.analyze([...this.checked]));
    this.list = node(sidebar, 'nav', undefined, 'note-organizer-list'); this.list.setAttribute('aria-label', t('organizer.title'));
    for (const group of ['ready', 'analyzing', 'waiting', 'done'] as const) {
      const area = group === 'waiting' ? details(this.list, t('organizer.waiting')) : node(this.list, 'section');
      if (group !== 'waiting') node(area, 'h3', t(`organizer.${group}`));
      this.groups.set(group, area);
    }
    this.detail = node(layout, 'section', undefined, 'note-organizer-detail');
    const detailHead = node(this.detail, 'header', undefined, 'note-organizer-detail-head');
    this.title = node(detailHead, 'h3'); button(detailHead, t('organizer.openNote'), () => { const path = this.previewPath(); if (path) controller.openNote(path); });
    this.info = node(this.detail, 'p', '', 'note-organizer-muted');
    this.preview = node(this.detail, 'article', undefined, 'note-organizer-preview markdown-rendered');
    this.controls = node(this.detail, 'footer', undefined, 'note-organizer-action-bar');
    this.undoBar = node(container, 'div', undefined, 'note-organizer-undo'); this.undoBar.setAttribute('role', 'status'); this.undoBar.hidden = true;
    this.recent = details(container, t('organizer.recent'));
    container.addEventListener('keydown', this.keydown);
    this.unsubscribe = controller.subscribe(() => this.render()); this.render();
  }
  private entries(): readonly FilingEntry[] { return this.controller.state().filing.filter(entry => entry.status !== 'ignored'); }
  private selected(): FilingEntry | undefined { return this.entries().find(entry => entry.path === this.current); }
  private previewPath(): string | null { const entry = this.selected(); return entry?.status === 'done' ? this.controller.recentMoves().find(record => record.id === entry.moveRecordId)?.to ?? entry.path : entry?.path ?? null; }
  private render(): void {
    if (!this.alive) return;
    const entries = this.entries(), paths = new Set(entries.map(entry => entry.path));
    const network = this.controller.state().network;
    this.status.textContent = this.feedback || (network.reason ? translateMessage(network.reason) : !this.controller.settings().inbox ? t('organizer.pickInbox') : entries.length ? '' : t('organizer.empty'));
    if (!this.current || !paths.has(this.current)) { this.current = entries.find(entry => entry.status === 'ready')?.path ?? entries[0]?.path ?? null; this.selectedDestination = null; this.signature = ''; }
    for (const [path, row] of this.rows) if (!paths.has(path)) { row.element.remove(); this.rows.delete(path); this.checked.delete(path); }
    for (const entry of entries) {
      let row = this.rows.get(entry.path);
      if (!row) {
        const group = groupFor(entry), element = node(this.groups.get(group)!, 'div', undefined, 'note-organizer-row');
        const label = node(element, 'label'); const check = node(label, 'input'); check.type = 'checkbox'; check.setAttribute('aria-label', t('organizer.selectNote', { name: basename(entry.path) }));
        check.addEventListener('change', () => { if (check.checked) this.checked.add(entry.path); else this.checked.delete(entry.path); this.updateSelection(); });
        const open = button(element, basename(entry.path), () => this.select(entry.path));
        const description = node(open, 'span', '', 'note-organizer-row-path');
        row = { element, open, check, description, group }; this.rows.set(entry.path, row);
      }
      const group = groupFor(entry);
      if (row.group !== group) {
        const active = row.element.contains(this.container.ownerDocument.activeElement) ? this.container.ownerDocument.activeElement as HTMLElement : null;
        this.groups.get(group)!.append(row.element); row.group = group; active?.focus({ preventScroll: true });
      }
      row.check.checked = this.checked.has(entry.path); row.check.disabled = entry.status === 'done' || entry.status === 'moving';
      if (row.check.disabled) { this.checked.delete(entry.path); row.check.checked = false; }
      const target = this.controller.folders().find(folder => folder.id === entry.proposal?.selected);
      row.description.textContent = entry.status === 'done' ? t('organizer.done') : entry.status === 'analyzing' ? t('organizer.preparing') : target ? '→ ' + breadcrumb(target.path) : entry.message ? translateMessage(entry.message) : t('organizer.waiting');
      row.open.setAttribute('aria-current', String(entry.path === this.current));
    }
    this.updateSelection();
    for (const [group, area] of this.groups) area.hidden = ![...this.rows.values()].some(row => row.group === group);
    this.renderHistory(); this.renderUndo();
    const selected = this.selected();
    if (!selected) { this.detail.hidden = true; return; }
    this.detail.hidden = false;
    const signature = this.detailSignature(selected);
    if (signature !== this.signature) { this.signature = signature; this.renderDetail(selected); }
  }
  private detailSignature(entry: FilingEntry): string { return JSON.stringify([entry, this.selectedDestination, this.controller.folders().filter(folder => folder.id === this.selectedDestination || folder.id === entry.proposal?.selected || entry.proposal?.ranked.some(item => item.targetId === folder.id)), this.busy]); }
  private updateSelection(): void { this.selectedCount.textContent = t('organizer.selectedCount', { count: this.checked.size }); this.bulk.disabled = this.checked.size === 0; }
  private select(path: string): void {
    if (!this.rows.has(path)) return;
    this.feedback = ''; this.current = path; this.selectedDestination = null; this.signature = ''; this.plan = null; this.preparation++;
    for (const entry of this.entries()) {
      const row = this.rows.get(entry.path)!; const group = groupFor(entry);
      if (row.group !== group) { this.groups.get(group)!.append(row.element); row.group = group; }
    }
    this.render();
  }
  private renderDetail(entry: FilingEntry): void {
    this.title.textContent = basename(entry.path);
    const path = this.previewPath()!;
    const previewKey = JSON.stringify([path, entry.proposal?.source.contentHash ?? entry.updatedAt]);
    if (this.previewKey !== previewKey) { this.previewKey = previewKey; void this.showPreview(path); }
    const active = this.controls.contains(this.container.ownerDocument.activeElement) ? (this.container.ownerDocument.activeElement as HTMLElement)?.dataset.action : undefined;
    this.controls.replaceChildren(); this.plan = null; this.preparation++;
    const excerpt = entry.proposal?.excerpt ?? entry.excerpt;
    this.info.textContent = excerpt ? t('organizer.excerpt', { sent: excerpt.sentChars, total: excerpt.originalChars }) : '';
    if (entry.status === 'done') { node(this.controls, 'span', t('organizer.done')); if (entry.moveRecordId) button(this.controls, t('organizer.undo'), () => { void this.run(() => this.controller.undoMove(entry.moveRecordId!)); }); return; }
    if (entry.status === 'moving' || this.busy) { node(this.controls, 'span', t('organizer.moving')); return; }
    if (entry.status === 'analyzing') node(this.controls, 'span', t('organizer.preparing'));
    else if (entry.message) node(this.controls, 'span', translateMessage(entry.message), 'note-organizer-feedback');
    const accept = button(this.controls, t('organizer.file'), () => { void this.accept(); }, true); accept.dataset.action = 'accept'; accept.disabled = true; accept.hidden = true;
    const destination = node(this.controls, 'span', '', 'note-organizer-path');
    const prepare = async (id: string) => {
      const generation = ++this.preparation; this.plan = null; accept.disabled = true;
      try {
        const plan = await this.controller.prepareMove(entry.path, id);
        if (!this.alive || generation !== this.preparation || this.current !== entry.path) return;
        this.plan = plan; this.signature = this.detailSignature(entry); const folder = this.controller.folders().find(value => value.id === id);
        accept.textContent = t('organizer.moveTo', { path: breadcrumb(folder?.path ?? plan.destination) }); accept.hidden = false;
        accept.disabled = Date.now() < this.acceptAfter; destination.textContent = '';
        clearTimeout(this.guardTimer); if (accept.disabled) this.guardTimer = setTimeout(() => { if (this.plan?.id === plan.id && !this.busy) accept.disabled = false; }, this.acceptAfter - Date.now());
      } catch (error) { if (generation === this.preparation && this.current === entry.path) destination.textContent = errorText(error); }
    };
    const targetId = this.selectedDestination ?? entry.proposal?.selected;
    if (targetId) void prepare(targetId);
    else if (entry.status !== 'analyzing') button(this.controls, t('organizer.analyzeOne'), () => this.controller.analyzeNote(entry.path));
    const choose = button(this.controls, t('organizer.choose'), () => this.actions.folder(id => this.chooseDestination(entry.path, id))); choose.dataset.action = 'choose';
    const skip = button(this.controls, t('organizer.skip'), () => this.next(1)); skip.dataset.action = 'skip';
    const more = button(this.controls, '…', () => this.actions.menu(more, [{ title: t('organizer.ignore'), run: () => { this.controller.ignoreNote(entry.path); } }])); more.setAttribute('aria-label', t('organizer.more')); more.dataset.action = 'more';
    const ranked = entry.proposal?.ranked ?? [];
    if (ranked.length > 1 && ranked[0]!.probability - ranked[1]!.probability < .2) {
      const alternatives = node(this.controls, 'div', undefined, 'note-organizer-alternatives'); node(alternatives, 'span', t('organizer.alternatives'));
      for (const candidate of ranked.filter(candidate => candidate.targetId !== entry.proposal?.selected).slice(0, 2)) {
        const folder = this.controller.folders().find(folder => folder.id === candidate.targetId);
        if (folder) button(alternatives, breadcrumb(folder.path), () => this.chooseDestination(entry.path, folder.id));
      }
    }
    if (active) this.controls.querySelector<HTMLButtonElement>(`[data-action="${active}"]`)?.focus({ preventScroll: true });
  }
  private chooseDestination(path: string, id: string): void { if (this.current !== path) return; this.selectedDestination = id; this.signature = ''; this.render(); }
  private async showPreview(path: string): Promise<void> {
    const generation = ++this.previewRequest; this.previewCleanup?.(); this.previewCleanup = undefined;
    this.preview.replaceChildren();
    try {
      const result = await this.controller.readPreview(path);
      if (!this.alive || generation !== this.previewRequest) return;
      const content = this.container.ownerDocument.createElement('div');
      const cleanup = await this.actions.preview(result.text, content, path);
      if (!this.alive || generation !== this.previewRequest) { cleanup?.(); return; }
      this.previewCleanup = cleanup || undefined; this.preview.replaceChildren(content);
      if (result.truncated) node(this.preview, 'p', t('organizer.previewLimited'), 'note-organizer-muted');
    } catch (error) { if (generation === this.previewRequest) this.preview.textContent = errorText(error); }
  }
  private async accept(): Promise<void> {
    const plan = this.plan; if (!plan || this.busy || Date.now() < this.acceptAfter) return;
    this.feedback = ''; this.busy = true; this.acceptAfter = Date.now() + 400; const path = this.current; this.signature = ''; this.render();
    try {
      await this.controller.confirmMove(plan); this.lastMove = plan.id; this.checked.delete(plan.source.path);
      this.busy = false; this.acceptAfter = Date.now() + 400;
      if (this.current === path) this.next(1, true);
    } catch (error) { this.feedback = errorText(error); this.busy = false; }
    this.signature = ''; this.render();
  }
  private next(direction: number, pendingOnly = false): void {
    const paths = [...this.rows.keys()]; const index = paths.indexOf(this.current ?? '');
    for (let offset = 1; offset <= paths.length; offset++) {
      const next = paths[(index + direction * offset + paths.length) % paths.length]!;
      const entry = this.entries().find(entry => entry.path === next);
      if (entry && (!pendingOnly || !['done', 'moving', 'ignored'].includes(entry.status))) { this.select(next); return; }
    }
  }
  private onKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || (event.target instanceof HTMLElement && event.target.matches('input,textarea,select,[contenteditable="true"]'))) return;
    const key = event.key.toLowerCase();
    if (!['j', 'k', 'enter', 'e', 's', 'z'].includes(key)) return;
    if (key === 'enter' && event.target instanceof HTMLButtonElement && event.target.dataset.action !== 'accept') return;
    event.preventDefault();
    if (key === 'j' || key === 'k' || key === 's') this.next(key === 'k' ? -1 : 1);
    else if (key === 'enter') void this.accept();
    else if (key === 'e') this.controls.querySelector<HTMLButtonElement>('[data-action="choose"]')?.click();
    else if (key === 'z' && this.lastMove) void this.run(() => this.controller.undoMove(this.lastMove!));
  }
  private renderHistory(): void {
    const records = this.controller.recentMoves().slice(-20).reverse(); const signature = JSON.stringify(records);
    if (this.recent.dataset.signature === signature || this.recent.contains(this.container.ownerDocument.activeElement)) return;
    this.recent.dataset.signature = signature; this.recent.replaceChildren(); node(this.recent, 'summary', t('organizer.recent'));
    for (const record of records) {
      const row = node(this.recent, 'div', undefined, 'note-organizer-recent'); node(row, 'span', record.to);
      if (record.status === 'done') button(row, t('organizer.undo'), () => { void this.run(() => this.controller.undoMove(record.id)); });
      else if (record.status === 'review' || record.status === 'intent') { node(row, 'span', record.message ? translateMessage(record.message) : t('organizer.needsReview')); if (record.status === 'review') button(row, t('organizer.acknowledge'), () => { void this.run(() => this.controller.acknowledgeMove(record.id)); }); }
      else node(row, 'span', t(record.status === 'archived' ? 'organizer.archived' : 'organizer.undone'));
    }
  }
  private renderUndo(): void {
    const record = this.controller.recentMoves().find(item => item.id === this.lastMove && item.status === 'done');
    if (this.undoBar.dataset.record === record?.id) return;
    this.undoBar.replaceChildren(); this.undoBar.hidden = !record; this.undoBar.dataset.record = record?.id ?? '';
    if (record) { node(this.undoBar, 'span', t('organizer.filedAt', { path: record.to })); button(this.undoBar, t('organizer.undo'), () => { void this.run(() => this.controller.undoMove(record.id)); }); }
  }
  private async run(action: () => Promise<void>): Promise<void> { this.feedback = ''; try { await action(); } catch (error) { this.feedback = errorText(error); } this.render(); }
  destroy(): void { this.alive = false; this.preparation++; this.previewRequest++; this.previewCleanup?.(); this.unsubscribe(); clearTimeout(this.guardTimer); this.container.removeEventListener('keydown', this.keydown); this.rows.clear(); }
}
