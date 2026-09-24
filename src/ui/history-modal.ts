import { App, Modal } from 'obsidian';
import type { OrganizerController } from './types';
import type { MoveRecord } from '../filing/types';
import { button, node } from './dom';
import { errorText, t, translateMessage } from '../i18n';

const LIMIT = 30;
const name = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
const folder = (path: string) => path.slice(0, path.lastIndexOf('/')).split('/').join(' › ') || '/';
const pending = (record: MoveRecord) => record.status === 'review' || record.status === 'intent';

/** Recent moves, with records that need review listed first. */
export class HistoryModal extends Modal {
  private unsubscribe: (() => void) | undefined;
  constructor(app: App, private readonly controller: OrganizerController) { super(app); }
  onOpen(): void {
    this.setTitle(t('organizer.recent')); this.contentEl.classList.add('note-organizer', 'note-organizer-history');
    this.unsubscribe = this.controller.subscribe(() => this.render()); this.render();
  }
  private render(): void {
    this.contentEl.replaceChildren();
    const records = this.controller.recentMoves().slice().reverse(), review = records.filter(pending), recent = records.filter(record => !pending(record)).slice(0, LIMIT);
    if (!records.length) { node(this.contentEl, 'p', t('settings.historyEmpty'), 'note-organizer-muted'); return; }
    if (review.length) { node(this.contentEl, 'h3', t('history.review')); for (const record of review) this.row(record); }
    if (recent.length) { node(this.contentEl, 'h3', t('history.recent')); for (const record of recent) this.row(record); }
  }
  private row(record: MoveRecord): void {
    const row = node(this.contentEl, 'div', undefined, 'note-organizer-history-row');
    const text = node(row, 'div', undefined, 'note-organizer-history-text');
    node(text, 'div', name(record.to), 'note-organizer-history-name');
    const when = new Date(record.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    node(text, 'div', `${folder(record.from)} → ${folder(record.to)} · ${when}`, 'note-organizer-muted');
    if (pending(record)) node(text, 'div', record.message ? translateMessage(record.message) : t('organizer.needsReview'), 'note-organizer-history-note');
    const action = node(row, 'div', undefined, 'note-organizer-history-action');
    const run = (control: HTMLButtonElement, work: () => Promise<void>) => {
      control.disabled = true;
      void work().catch(error => { control.disabled = false; node(text, 'div', errorText(error), 'note-organizer-feedback'); });
    };
    if (record.status === 'done') { const undo = button(action, t('organizer.undo'), () => run(undo, () => this.controller.undoMove(record.id))); }
    else if (record.status === 'review') { const done = button(action, t('organizer.acknowledge'), () => run(done, () => this.controller.acknowledgeMove(record.id))); }
    else if (record.status !== 'intent') node(action, 'span', t(record.status === 'archived' ? 'organizer.archived' : 'organizer.undone'), 'note-organizer-muted');
  }
  onClose(): void { this.unsubscribe?.(); this.contentEl.replaceChildren(); }
}
