import { App, Modal } from 'obsidian';
import type { OrganizerController } from './types';
import { button, node } from './dom';
import { t } from '../i18n';
import { PROVIDER_DEFAULTS } from '../settings';

export class AnalysisModal extends Modal {
  constructor(app: App, private readonly controller: OrganizerController, private readonly paths?: readonly string[]) { super(app); }
  onOpen(): void {
    this.setTitle(t('batch.title')); this.contentEl.classList.add('note-organizer');
    const preview = this.controller.previewAnalysis(this.paths), chosen = new Set(preview.notes.slice(0, preview.recommendedCount).map(note => note.path));
    node(this.contentEl, 'p', t('batch.summary', { count: preview.notes.length, min: preview.requestsPerNote.min, max: preview.requestsPerNote.max, remaining: preview.remainingRequests }));
    node(this.contentEl, 'p', t('batch.disclosure', { provider: PROVIDER_DEFAULTS[this.controller.settings().provider].name, endpoint: this.controller.settings().endpoint }), 'note-organizer-muted');
    if (preview.remainingRequests === 0) node(this.contentEl, 'p', t('batch.noBudget'));
    const selectActions = node(this.contentEl, 'div', undefined, 'note-organizer-actions');
    const list = node(this.contentEl, 'div', undefined, 'note-organizer-batch-list');
    const inputs: HTMLInputElement[] = [];
    const footer = node(this.contentEl, 'footer', undefined, 'note-organizer-actions');
    let submitted = false;
    const start = button(footer, '', () => { if (submitted || !chosen.size) return; submitted = true; start.disabled = true; this.controller.analyzeInbox([...chosen]); this.close(); }, true);
    button(footer, t('batch.cancel'), () => this.close());
    const update = () => { start.textContent = t('batch.start', { count: chosen.size }); start.disabled = chosen.size === 0 || preview.remainingRequests === 0; };
    for (const note of preview.notes) {
      const row = node(list, 'label', undefined, 'note-organizer-check-row'); const input = node(row, 'input'); input.type = 'checkbox'; input.checked = chosen.has(note.path); input.value = note.path; inputs.push(input); node(row, 'span', note.path);
      input.addEventListener('change', () => { if (input.checked) chosen.add(note.path); else chosen.delete(note.path); update(); });
    }
    button(selectActions, t('batch.all'), () => { for (const input of inputs) { input.checked = true; chosen.add(input.value); } update(); });
    button(selectActions, t('batch.none'), () => { for (const input of inputs) input.checked = false; chosen.clear(); update(); });
    update();
  }
}
