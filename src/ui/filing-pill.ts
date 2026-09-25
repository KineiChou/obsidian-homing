import { setIcon } from 'obsidian';
import type { OrganizerController } from './types';
import type { FilingEntry, MovePlan } from '../filing/types';
import { closeAlternatives } from '../filing/alternatives';
import { button, node } from './dom';
import { errorText, t, translateMessage } from '../i18n';

export interface PillHost {
  chooseDestination(choose: (id: string) => void): void;
  menu(anchor: HTMLElement, items: readonly { title: string; run(): void }[]): void;
}
/** One note view. The pill lives in its content container, so it survives source, live preview and reading modes. */
export interface PillSurface {
  readonly parent: HTMLElement;
  file(): { readonly path: string } | null;
  hasFocus(): boolean;
  focusNote(): void;
  openNote(path: string): void;
}
export interface FilingPills {
  attach(surface: PillSurface): () => void;
  refresh(): void;
  open(activePath: string | null, checking?: boolean): boolean;
}
interface ManualDestination { readonly proposalId: string; readonly id: string }
type Mode = 'hidden' | 'preparing' | 'undecided' | 'ready' | 'moving' | 'done';

const GUARD_MS = 400;
const OPEN_STATUSES = new Set(['waiting', 'analyzing', 'ready', 'unassigned', 'failed']);
const breadcrumb = (path: string) => path.split('/').join(' › ');
const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** A small floating control in the note's corner; it never shifts the note text or takes focus by itself. */
export function filingPills(controller: OrganizerController, host: PillHost): FilingPills {
  const pills = new Set<FilingPill>(), destinations = new Map<string, ManualDestination>();
  const shared = { destinations, changed: () => { for (const pill of pills) pill.render(); } };
  return {
    attach: surface => {
      const pill = new FilingPill(surface, controller, host, shared); pills.add(pill);
      return () => { pill.destroy(); pills.delete(pill); };
    },
    refresh: () => { for (const pill of pills) pill.render(); },
    open: (activePath, checking = false) => {
      const candidates = [...pills].filter(pill => pill.available());
      const pill = candidates.find(item => item.focused()) ?? candidates.find(item => item.path() === activePath);
      if (!pill) return false;
      if (!checking) pill.toggle(true, true);
      return true;
    },
  };
}

class FilingPill {
  private readonly host: HTMLElement;
  private readonly unsubscribe: () => void;
  private readonly outside = (event: MouseEvent) => { if (!this.host.contains(event.target as Node)) this.toggle(false); };
  private signature = '';
  private opened = false;
  private focusOnReady = false;
  private plan: MovePlan | null = null;
  private generation = 0;
  private busy = false;
  private feedback = '';
  private lastMove: { id: string; to: string } | null = null;
  private guardUntil = 0;
  private guardTimer: number | undefined;
  private previousFile: unknown;
  private fileContext = {};
  private alive = true;
  constructor(private readonly surface: PillSurface, private readonly controller: OrganizerController, private readonly hostActions: PillHost, private readonly shared: { destinations: Map<string, ManualDestination>; changed(): void }) {
    this.host = surface.parent.createDiv({ cls: 'note-organizer note-organizer-pill-host' });
    this.host.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); this.toggle(false); this.surface.focusNote(); } });
    surface.parent.classList.add('note-organizer-pill-parent');
    this.previousFile = this.file();
    this.unsubscribe = controller.subscribe(() => this.render()); this.render();
  }
  private get doc(): Document { return this.surface.parent.ownerDocument; }
  private file() { return this.surface.file(); }
  path(): string | null { return this.file()?.path ?? null; }
  focused(): boolean { return this.surface.hasFocus() || this.host.contains(this.doc.activeElement); }
  available(): boolean { const mode = this.model().mode; return mode === 'ready' || mode === 'undecided'; }
  private entry(): FilingEntry | undefined { const path = this.path(); return this.controller.state().filing.find(entry => entry.path === path); }
  private target(entry: FilingEntry | undefined): string | null | undefined {
    const manual = entry ? this.shared.destinations.get(entry.path) : undefined;
    return manual && manual.proposalId === (entry?.proposal?.id ?? '') ? manual.id : entry?.proposal?.selected;
  }
  private model(): { mode: Mode; entry?: FilingEntry; record?: { id: string; to: string } } {
    const path = this.path(), entry = this.entry();
    const record = this.lastMove && this.controller.recentMoves().find(item => item.id === this.lastMove!.id && item.status === 'done' && item.to === path);
    if (record) return { mode: 'done', record: { id: record.id, to: record.to } };
    if (!path || !entry || !OPEN_STATUSES.has(entry.status) && entry.status !== 'moving') return { mode: 'hidden' };
    if (entry.status === 'moving' || this.busy) return { mode: 'moving', entry };
    if (entry.status === 'analyzing') return { mode: 'preparing', entry };
    const target = this.target(entry);
    return { mode: target && this.controller.folders().some(folder => folder.id === target) ? 'ready' : 'undecided', entry };
  }
  toggle(open: boolean, focus = false): void {
    if (open === this.opened && !focus) return;
    this.opened = open; this.focusOnReady = open && focus; this.feedback = '';
    const doc = this.doc;
    if (open) doc.addEventListener('mousedown', this.outside, true); else doc.removeEventListener('mousedown', this.outside, true);
    this.signature = ''; this.render();
  }
  render(): void {
    if (!this.alive) return;
    // Filing renames the same file object; only a different file resets the done state.
    const file = this.file();
    if (file !== this.previousFile) {
      this.previousFile = file; this.fileContext = {}; this.generation++;
      this.lastMove = null; this.plan = null; this.busy = false; this.feedback = ''; this.focusOnReady = false;
      this.guardUntil = 0; window.clearTimeout(this.guardTimer);
      if (this.opened) { this.opened = false; this.doc.removeEventListener('mousedown', this.outside, true); }
      this.signature = '';
    }
    const model = this.model(), entry = model.entry, target = this.target(entry);
    const folders = this.controller.folders(), folder = folders.find(item => item.id === target);
    const width = this.surface.parent.clientWidth, compact = width > 0 && width < 520;
    const signature = JSON.stringify([model.mode, model.record, entry?.proposal?.id, entry?.status, entry?.message, entry?.excerpt, folder?.path, this.opened, this.busy, this.feedback, compact, this.guardUntil > Date.now()]);
    if (signature === this.signature) return;
    this.signature = signature;
    const active = this.host.contains(this.doc.activeElement) ? (this.doc.activeElement as HTMLElement).dataset.action : undefined;
    this.host.replaceChildren(); this.host.hidden = model.mode === 'hidden'; this.host.classList.toggle('is-compact', compact);
    if (model.mode === 'hidden') { if (this.opened) this.toggle(false); return; }
    if (model.mode === 'done') { this.renderDone(model.record!); this.restoreFocus(active); return; }
    const pill = node(this.host, 'button', undefined, 'note-organizer-pill'); pill.type = 'button'; pill.dataset.action = 'pill';
    pill.setAttribute('aria-expanded', String(this.opened)); pill.setAttribute('aria-haspopup', 'dialog');
    setIcon(node(pill, 'span', undefined, 'note-organizer-pill-icon'), model.mode === 'preparing' || model.mode === 'moving' ? 'loader' : 'inbox');
    const label = model.mode === 'ready' ? '→ ' + leaf(folder!.path) : model.mode === 'preparing' ? t('pill.preparing') : model.mode === 'moving' ? t('organizer.moving') : t('pill.undecided');
    node(pill, 'span', label, 'note-organizer-pill-label');
    const described = model.mode === 'ready' ? t('organizer.banner', { path: folder!.path }) : label;
    pill.setAttribute('aria-label', described); pill.title = described;
    pill.addEventListener('click', () => this.toggle(!this.opened));
    if (this.opened && (model.mode === 'ready' || model.mode === 'undecided')) this.renderPopover(entry!, model.mode === 'ready' ? folder!.id : null);
    else this.plan = null;
    this.restoreFocus(active);
  }
  private renderPopover(entry: FilingEntry, targetId: string | null): void {
    const popover = node(this.host, 'div', undefined, 'note-organizer-popover'); popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-label', t('pill.label'));
    const folders = this.controller.folders();
    if (targetId) {
      node(popover, 'div', t('pill.fileTo'), 'note-organizer-popover-label');
      node(popover, 'div', breadcrumb(folders.find(folder => folder.id === targetId)!.path), 'note-organizer-popover-target');
    } else node(popover, 'p', entry.message ? translateMessage(entry.message) : t('pill.noSuggestion'), 'note-organizer-muted');
    const ranked = entry.proposal?.ranked ?? [];
    if (targetId && closeAlternatives(entry.proposal).length) {
      const alternatives = node(popover, 'div', undefined, 'note-organizer-alternatives'); node(alternatives, 'span', t('organizer.alternatives'));
      for (const candidate of ranked.filter(item => item.targetId !== targetId).slice(0, 2)) {
        const folder = folders.find(item => item.id === candidate.targetId);
        if (folder) { const chip = button(alternatives, breadcrumb(folder.path), () => this.choose(entry, folder.id)); chip.className = 'note-organizer-chip'; }
      }
    }
    const excerpt = entry.proposal?.excerpt ?? entry.excerpt, attachments = this.controller.attachmentCount(entry.path);
    if (excerpt) node(popover, 'p', t('organizer.excerpt', { sent: excerpt.sentChars, total: excerpt.originalChars }), 'note-organizer-muted');
    // The prepared plan says which attachments follow the note; until then all of them count as staying.
    const attachmentNote = node(popover, 'p', attachments ? t('pill.attachments', { count: attachments }) : '', 'note-organizer-muted'); attachmentNote.hidden = !attachments;
    const actions = node(popover, 'div', undefined, 'note-organizer-actions');
    const status = node(popover, 'p', this.feedback, 'note-organizer-feedback'); status.setAttribute('role', 'status'); status.hidden = !this.feedback;
    if (targetId) {
      const accept = button(actions, t('organizer.file'), () => { void this.accept(); }, true); accept.dataset.action = 'accept'; accept.disabled = true;
      void this.prepare(entry.path, targetId, accept, status, attachmentNote, attachments);
    } else button(actions, t('organizer.analyzeOne'), () => { this.controller.analyzeNote(entry.path); this.toggle(false); }).dataset.action = 'analyze';
    const choose = button(actions, t('organizer.choose'), () => this.hostActions.chooseDestination(id => this.choose(entry, id))); choose.dataset.action = 'choose';
    const more = button(actions, '…', () => this.hostActions.menu(more, [
      ...(targetId ? [{ title: t('pill.reanalyze'), run: () => { this.controller.analyzeNote(entry.path); this.toggle(false); } }] : []),
      { title: t('organizer.ignore'), run: () => { this.controller.ignoreNote(entry.path); this.toggle(false); } },
    ])); more.setAttribute('aria-label', t('organizer.more')); more.dataset.action = 'more';
    if (this.focusOnReady && !targetId) { this.focusOnReady = false; (actions.querySelector('button'))?.focus(); }
  }
  private async prepare(path: string, targetId: string, accept: HTMLButtonElement, status: HTMLElement, attachmentNote: HTMLElement, attachments: number): Promise<void> {
    const generation = ++this.generation; this.plan = null;
    try {
      const plan = await this.controller.prepareMove(path, targetId);
      if (!this.alive || generation !== this.generation || !accept.isConnected) return;
      this.plan = plan; accept.disabled = false;
      const moving = plan.attachments.length, staying = Math.max(0, attachments - moving);
      attachmentNote.textContent = [moving ? t('pill.attachmentsMove', { count: moving }) : '', staying ? t('pill.attachments', { count: staying }) : ''].filter(Boolean).join(' · ');
      attachmentNote.hidden = !moving && !staying;
      if (this.focusOnReady) { this.focusOnReady = false; accept.focus(); }
    } catch (error) {
      if (!this.alive || generation !== this.generation || !accept.isConnected) return;
      // Updating this attempt's status must not render a new preparation attempt.
      this.feedback = errorText(error); status.textContent = this.feedback; status.hidden = false;
    }
  }
  private choose(entry: FilingEntry, id: string): void {
    const current = this.entry(), proposalId = entry.proposal?.id ?? '';
    if (!this.alive || current?.path !== entry.path || (current.proposal?.id ?? '') !== proposalId) return;
    // The chosen folder is shown first; only the File button moves the note.
    this.shared.destinations.set(entry.path, { proposalId, id }); this.opened = true; this.shared.changed();
  }
  private async accept(): Promise<void> { if (this.plan) await this.confirm(this.plan); }
  private async confirm(plan: MovePlan): Promise<void> {
    if (this.busy || Date.now() < this.guardUntil) return;
    if (this.path() !== plan.source.path) { this.render(); return; }
    const file = this.file(), context = this.fileContext;
    const current = () => this.alive && this.file() === file && this.fileContext === context;
    this.busy = true; this.feedback = ''; this.render();
    try {
      await this.controller.confirmMove(plan);
      this.shared.destinations.delete(plan.source.path);
      if (!current()) return;
      this.lastMove = { id: plan.id, to: plan.destination };
      this.opened = false; this.doc.removeEventListener('mousedown', this.outside, true);
      this.guardUntil = Date.now() + GUARD_MS; window.clearTimeout(this.guardTimer);
      this.guardTimer = window.setTimeout(() => { this.signature = ''; this.render(); }, GUARD_MS);
    } catch (error) { if (!current()) return; this.feedback = errorText(error); }
    this.busy = false; this.signature = ''; this.render();
  }
  private renderDone(record: { id: string; to: string }): void {
    const group = node(this.host, 'div', undefined, 'note-organizer-pill is-done'); group.setAttribute('role', 'status');
    setIcon(node(group, 'span', undefined, 'note-organizer-pill-icon'), 'check');
    const folder = record.to.slice(0, record.to.lastIndexOf('/'));
    node(group, 'span', t('organizer.filedAt', { path: breadcrumb(folder) }), 'note-organizer-pill-label');
    const guarded = Date.now() < this.guardUntil;
    const context = this.fileContext, file = this.file();
    const current = () => this.alive && this.fileContext === context && this.file() === file;
    const undo = button(group, t('organizer.undo'), () => { undo.disabled = true; void this.controller.undoMove(record.id).then(() => { if (current()) { this.lastMove = null; this.signature = ''; this.render(); } }).catch(error => { if (current()) { this.feedback = errorText(error); this.signature = ''; this.render(); } }); });
    undo.className = 'note-organizer-link-button'; undo.dataset.action = 'undo'; undo.disabled = guarded;
    const open = this.controller.state().filing.filter(entry => OPEN_STATUSES.has(entry.status) && entry.path !== record.to);
    const next = this.controller.nextInboxNote(record.to);
    if (next) {
      const forward = button(group, t('pill.next', { count: open.length }) + ' →', () => this.surface.openNote(next));
      forward.className = 'note-organizer-link-button'; forward.dataset.action = 'next'; forward.disabled = guarded;
    }
    if (this.feedback) node(group, 'span', this.feedback, 'note-organizer-feedback');
  }
  private restoreFocus(action: string | undefined): void { if (action) this.host.querySelector<HTMLElement>(`[data-action="${action}"]`)?.focus({ preventScroll: true }); }
  destroy(): void { this.alive = false; this.generation++; window.clearTimeout(this.guardTimer); this.doc.removeEventListener('mousedown', this.outside, true); this.unsubscribe(); this.host.remove(); if (!this.surface.parent.querySelector('.note-organizer-pill-host')) this.surface.parent.classList.remove('note-organizer-pill-parent'); }
}
