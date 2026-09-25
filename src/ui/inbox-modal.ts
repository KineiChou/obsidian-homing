import { App, Modal, setIcon } from 'obsidian';
import type { OrganizerController } from './types';
import type { FilingEntry, SourceVersion } from '../filing/types';
import { closeAlternatives } from '../filing/alternatives';
import { OrganizerError } from '../core/errors';
import { button, node } from './dom';
import { errorText, t, translateMessage } from '../i18n';

export interface InboxModalHost {
  chooseDestination(choose: (id: string) => void): void;
  openNote(path: string): void;
  analyze(paths?: readonly string[]): void;
}
type Result = { status: 'moving' } | { status: 'done'; recordId: string; folder: string } | { status: 'failed'; message: string };

const OPEN = new Set(['waiting', 'analyzing', 'ready', 'unassigned', 'failed']);
const PREVIEW_CHARS = 280;
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
const breadcrumb = (path: string) => path.split('/').join(' › ');
/** Close rankings are left unselected so a batch never files an uncertain note by default. */
const closeCall = (entry: FilingEntry) => closeAlternatives(entry.proposal).length > 0;
function plainStart(text: string): string {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/[#>*_`[\]]+/g, '').replace(/\s+/g, ' ').trim();
  return body.length > PREVIEW_CHARS ? body.slice(0, PREVIEW_CHARS) + '…' : body;
}

/** Inbox overview in a modal: every destination is visible before one explicit batch confirmation. */
export class InboxModal extends Modal {
  private readonly selected = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly destinations = new Map<string, { proposalId: string; id: string; source: SourceVersion }>();
  private readonly results = new Map<string, Result>();
  private readonly previews = new Map<string, string>();
  private list!: HTMLElement;
  private summary!: HTMLElement;
  private submit!: HTMLButtonElement;
  private unsubscribe: (() => void) | undefined;
  private signature = '';
  private busy = false;
  private outcome = '';
  private alive = false;
  private choiceGeneration = 0;
  constructor(app: App, private readonly controller: OrganizerController, private readonly host: InboxModalHost, private readonly preselect?: readonly string[]) { super(app); }
  onOpen(): void {
    this.alive = true; this.setTitle(t('organizer.title'));
    this.contentEl.classList.add('note-organizer', 'note-organizer-inbox-modal');
    this.summary = node(this.contentEl, 'p', '', 'note-organizer-muted'); this.summary.setAttribute('role', 'status');
    this.list = node(this.contentEl, 'div', undefined, 'note-organizer-batch-list');
    const footer = node(this.contentEl, 'footer', undefined, 'note-organizer-modal-footer');
    button(footer, t('inbox.openFirst'), () => { const next = this.controller.nextInboxNote(); if (next) { this.host.openNote(next); this.close(); } });
    this.submit = button(footer, '', () => { void this.fileSelected(); }, true);
    this.unsubscribe = this.controller.subscribe(() => this.render()); this.render();
  }
  private entries(): FilingEntry[] { return this.controller.state().filing.filter(entry => OPEN.has(entry.status) || entry.status === 'moving' || this.results.has(entry.path)); }
  private target(entry: FilingEntry): string | null {
    const manual = this.destinations.get(entry.path);
    const id = manual && manual.proposalId === (entry.proposal?.id ?? '') ? manual.id : entry.proposal?.selected ?? null;
    return id && this.controller.folders().some(folder => folder.id === id) ? id : null;
  }
  private source(entry: FilingEntry): SourceVersion | undefined {
    const manual = this.destinations.get(entry.path);
    return manual?.proposalId === (entry.proposal?.id ?? '') ? manual.source : entry.proposal?.source;
  }
  private render(): void {
    if (!this.alive) return;
    const entries = this.entries(), fileable = entries.filter(entry => this.target(entry) && this.source(entry) && entry.status !== 'analyzing');
    for (const entry of fileable) if (!this.seen.has(entry.path)) {
      this.seen.add(entry.path);
      if (this.preselect ? this.preselect.includes(entry.path) : !closeCall(entry) && !this.destinations.has(entry.path)) this.selected.add(entry.path);
    }
    for (const path of this.selected) if (!fileable.some(entry => entry.path === path) || this.results.get(path)?.status === 'done') this.selected.delete(path);
    const signature = JSON.stringify([entries, [...this.destinations], [...this.results], [...this.previews.keys()], [...this.selected], this.busy, this.controller.state().network.reason]);
    this.updateSubmit();
    if (signature === this.signature) return;
    this.signature = signature;
    const focused = (this.contentEl.ownerDocument.activeElement as HTMLElement | null)?.dataset.focus;
    const pending = entries.filter(entry => !fileable.includes(entry) && !this.results.has(entry.path));
    const reason = this.controller.state().network.reason;
    this.summary.textContent = entries.length ? t('inbox.summary', { ready: fileable.filter(entry => !this.results.has(entry.path)).length, pending: pending.length }) + (reason ? ' · ' + translateMessage(reason) : '') + (this.outcome ? ' · ' + this.outcome : '') : t('organizer.empty');
    this.list.replaceChildren();
    const suggested = [...fileable, ...entries.filter(entry => !fileable.includes(entry) && this.results.has(entry.path))];
    if (suggested.length) { node(this.list, 'h3', t('inbox.suggested')); for (const entry of suggested) this.row(entry); }
    if (pending.length) {
      const heading = node(this.list, 'div', undefined, 'note-organizer-section-head'); node(heading, 'h3', t('inbox.undecided'));
      const analyze = button(heading, t('inbox.analyze'), () => this.host.analyze(pending.filter(entry => entry.status !== 'analyzing').map(entry => entry.path)));
      analyze.className = 'note-organizer-link-button'; analyze.dataset.focus = 'analyze';
      for (const entry of pending) this.row(entry);
    }
    if (focused) [...this.list.querySelectorAll<HTMLElement>('[data-focus]')].find(element => element.dataset.focus === focused)?.focus({ preventScroll: true });
  }
  private row(entry: FilingEntry): void {
    const row = node(this.list, 'section', undefined, 'note-organizer-inbox-row'), result = this.results.get(entry.path);
    const targetId = this.target(entry), folder = this.controller.folders().find(item => item.id === targetId);
    const head = node(row, 'div', undefined, 'note-organizer-inbox-row-head');
    if (folder) {
      const check = node(head, 'input'); check.type = 'checkbox'; check.dataset.focus = 'check:' + entry.path;
      check.checked = this.selected.has(entry.path); check.disabled = this.busy || !!result && result.status !== 'failed';
      check.setAttribute('aria-label', t('inbox.selectRow', { name: basename(entry.path), path: folder.path }));
      check.addEventListener('change', () => { if (check.checked) this.selected.add(entry.path); else this.selected.delete(entry.path); this.render(); });
    }
    const title = button(head, basename(entry.path), () => { this.host.openNote(entry.path); this.close(); }); title.className = 'note-organizer-inbox-title'; title.dataset.focus = 'open:' + entry.path;
    const toggle = button(head, '', () => { void this.togglePreview(entry.path); }); toggle.className = 'note-organizer-icon-button clickable-icon'; toggle.dataset.focus = 'preview:' + entry.path;
    setIcon(toggle, this.previews.has(entry.path) ? 'chevron-up' : 'chevron-down'); toggle.setAttribute('aria-label', t('inbox.preview')); toggle.setAttribute('aria-expanded', String(this.previews.has(entry.path)));
    const detail = node(row, 'div', undefined, 'note-organizer-inbox-detail');
    if (result?.status === 'done') {
      node(detail, 'span', t('organizer.filedAt', { path: breadcrumb(result.folder) }));
      const undo = button(detail, t('organizer.undo'), () => { undo.disabled = true; void this.controller.undoMove(result.recordId).then(() => { this.results.delete(entry.path); this.render(); }).catch(error => { this.results.set(entry.path, { status: 'failed', message: errorText(error) }); this.render(); }); });
      undo.className = 'note-organizer-link-button';
    } else if (result?.status === 'moving' || entry.status === 'moving') node(detail, 'span', t('organizer.moving'));
    else if (folder) {
      node(detail, 'span', '→ ' + breadcrumb(folder.path));
      const change = button(detail, t('inbox.change'), () => this.choose(entry)); change.className = 'note-organizer-link-button'; change.dataset.focus = 'change:' + entry.path; change.disabled = this.busy;
      if (closeCall(entry) && !this.destinations.has(entry.path)) node(detail, 'span', t('inbox.closeCall', { count: Math.min(2, closeAlternatives(entry.proposal).length) }), 'note-organizer-muted');
    } else {
      node(detail, 'span', entry.status === 'analyzing' ? t('organizer.preparing') : entry.message ? translateMessage(entry.message) : t('organizer.undecided'), 'note-organizer-muted');
      if (entry.status !== 'analyzing') { const choose = button(detail, t('organizer.choose'), () => this.choose(entry)); choose.className = 'note-organizer-link-button'; choose.dataset.focus = 'change:' + entry.path; choose.disabled = this.busy; }
    }
    if (result?.status === 'failed') { const status = node(row, 'p', result.message, 'note-organizer-feedback'); status.setAttribute('role', 'status'); }
    const preview = this.previews.get(entry.path);
    if (preview !== undefined) node(row, 'p', preview, 'note-organizer-inbox-preview');
  }
  private choose(entry: FilingEntry): void {
    if (!this.alive || this.busy) return;
    const generation = ++this.choiceGeneration, proposalId = entry.proposal?.id ?? '';
    const current = () => this.alive && !this.busy && generation === this.choiceGeneration && this.entries().some(item => item.path === entry.path && (item.proposal?.id ?? '') === proposalId);
    this.host.chooseDestination(id => {
      if (!current()) return;
      const select = (source: SourceVersion) => {
        if (!current()) return;
        this.destinations.set(entry.path, { proposalId, id, source: { ...source } }); this.results.delete(entry.path); this.selected.add(entry.path); this.seen.add(entry.path); this.render();
      };
      if (entry.proposal) select(entry.proposal.source);
      else void this.controller.prepareMove(entry.path, id).then(plan => select(plan.source)).catch(error => {
        if (current()) { this.results.set(entry.path, { status: 'failed', message: errorText(error) }); this.render(); }
      });
    });
  }
  private async togglePreview(path: string): Promise<void> {
    if (this.previews.delete(path)) { this.render(); return; }
    try { const { text } = await this.controller.readPreview(path); if (this.alive) this.previews.set(path, plainStart(text)); }
    catch (error) { this.previews.set(path, errorText(error)); }
    this.render();
  }
  private updateSubmit(): void { this.submit.textContent = t('inbox.fileSelected', { count: this.selected.size }); this.submit.disabled = this.busy || this.selected.size === 0; }
  private async fileSelected(): Promise<void> {
    if (this.busy) return;
    const batch = this.entries().filter(entry => this.selected.has(entry.path)).flatMap(entry => {
      const target = this.target(entry), source = this.source(entry);
      return target && source ? [{ path: entry.path, target, source: { ...source } }] : [];
    });
    this.busy = true; this.choiceGeneration++; this.outcome = ''; let done = 0;
    for (const item of batch) {
      // Each note is prepared and revalidated on its own; one failure never stops or hides the others.
      this.results.set(item.path, { status: 'moving' }); this.render();
      try {
        const plan = await this.controller.prepareMove(item.path, item.target);
        const source = plan.source;
        if (source.noteId !== item.source.noteId || source.path !== item.source.path || source.revision !== item.source.revision || source.contentHash !== item.source.contentHash) throw new OrganizerError('stale', 'error.moveStale');
        if (!this.alive) return;
        await this.controller.confirmMove(plan);
        this.results.set(item.path, { status: 'done', recordId: plan.id, folder: plan.destination.slice(0, plan.destination.lastIndexOf('/')) }); this.selected.delete(item.path); done++;
      } catch (error) { this.results.set(item.path, { status: 'failed', message: errorText(error) }); }
      if (!this.alive) return;
    }
    this.busy = false; this.outcome = t('inbox.result', { done, total: batch.length }); this.signature = ''; this.render();
  }
  onClose(): void { this.alive = false; this.choiceGeneration++; this.unsubscribe?.(); this.contentEl.replaceChildren(); }
}
