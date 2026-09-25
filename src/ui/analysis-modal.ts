import { App, Modal } from 'obsidian';
import type { OrganizerController } from './types';
import { button, node } from './dom';
import { t } from '../i18n';
import { PROVIDER_DEFAULTS } from '../settings';

const breadcrumb = (path: string) => path.split('/').slice(0, -1).join(' › ');
const title = (path: string) => path.split('/').at(-1)!.replace(/\.md$/i, '');

export class AnalysisModal extends Modal {
  constructor(app: App, private readonly controller: OrganizerController, private readonly paths?: readonly string[]) { super(app); }
  onOpen(): void {
    this.setTitle(t('batch.title')); this.contentEl.classList.add('note-organizer', 'note-organizer-analysis-modal');
    const preview = this.controller.previewAnalysis(this.paths), chosen = new Set(preview.notes.slice(0, preview.recommendedCount).map(note => note.path));
    const { min, max } = preview.requestsPerNote, settings = this.controller.settings();
    const stats = node(this.contentEl, 'div', undefined, 'note-organizer-analysis-stats');
    node(stats, 'span', t('batch.notes', { count: preview.notes.length }), 'note-organizer-stat');
    node(stats, 'span', min === max ? t(min === 1 ? 'batch.requestOne' : 'batch.requests', { count: min }) : t('batch.requestsRange', { min, max }), 'note-organizer-stat');
    node(stats, 'span', t('batch.remaining', { remaining: preview.remainingRequests }), 'note-organizer-stat' + (preview.remainingRequests === 0 ? ' is-warning' : ''));
    node(this.contentEl, 'p', t('batch.disclosure', { provider: PROVIDER_DEFAULTS[settings.provider].name, endpoint: settings.endpoint }), 'note-organizer-analysis-disclosure');
    if (preview.remainingRequests === 0) node(this.contentEl, 'p', t('batch.noBudget'), 'note-organizer-analysis-warning');
    const card = node(this.contentEl, 'div', undefined, 'note-organizer-analysis-card');
    const head = node(card, 'div', undefined, 'note-organizer-analysis-head');
    const count = node(head, 'span', '', 'note-organizer-analysis-count');
    const tools = node(head, 'span', undefined, 'note-organizer-analysis-tools');
    const list = node(card, 'div', undefined, 'note-organizer-analysis-list');
    const inputs: HTMLInputElement[] = [];
    const footer = node(this.contentEl, 'footer', undefined, 'note-organizer-modal-footer');
    button(footer, t('batch.cancel'), () => this.close());
    let submitted = false;
    const start = button(footer, '', () => { if (submitted || !chosen.size) return; submitted = true; start.disabled = true; this.controller.analyzeInbox([...chosen]); this.close(); }, true);
    const update = () => {
      start.textContent = t('batch.start', { count: chosen.size }); start.disabled = chosen.size === 0 || preview.remainingRequests === 0;
      count.textContent = t('batch.selected', { count: chosen.size, total: preview.notes.length });
    };
    const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    for (const note of preview.notes) {
      const row = node(list, 'label', undefined, 'note-organizer-analysis-row');
      const input = node(row, 'input'); input.type = 'checkbox'; input.checked = chosen.has(note.path); input.value = note.path; input.setAttribute('aria-label', note.path); inputs.push(input);
      const text = node(row, 'span', undefined, 'note-organizer-analysis-text');
      node(text, 'span', title(note.path), 'note-organizer-analysis-title');
      const folder = breadcrumb(note.path); if (folder) node(text, 'span', folder, 'note-organizer-analysis-meta');
      if (note.modifiedAt) node(row, 'span', format.format(note.modifiedAt), 'note-organizer-analysis-date');
      input.addEventListener('change', () => { if (input.checked) chosen.add(note.path); else chosen.delete(note.path); update(); });
    }
    if (!preview.notes.length) node(list, 'p', t('organizer.empty'), 'note-organizer-analysis-empty');
    const all = button(tools, t('batch.all'), () => { for (const input of inputs) { input.checked = true; chosen.add(input.value); } update(); });
    const none = button(tools, t('batch.none'), () => { for (const input of inputs) input.checked = false; chosen.clear(); update(); });
    for (const control of [all, none]) { control.className = 'note-organizer-link-button'; control.disabled = !inputs.length; }
    update();
  }
}
