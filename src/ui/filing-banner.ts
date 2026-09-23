import { editorInfoField } from 'obsidian';
import { showPanel, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { OrganizerController } from './types';
import type { MovePlan } from '../filing/types';
import { button, node } from './dom';
import { Emitter } from '../core/events';
import { errorText, t } from '../i18n';

export function filingBanner(controller: OrganizerController): Extension {
  const dismissed = new Set<string>(), dismissals = new Emitter();
  return showPanel.of(view => new FilingBanner(view, controller, dismissed, dismissals));
}
class FilingBanner implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private readonly unsubscribe: () => void;
  private signature = '';
  private generation = 0;
  private alive = true;
  private busy = false;
  private plan: MovePlan | null = null;
  private lastMove: string | null = null;
  constructor(private readonly view: EditorView, private readonly controller: OrganizerController, private readonly dismissed: Set<string>, private readonly dismissals: Emitter) {
    this.dom = view.dom.ownerDocument.createElement('div'); this.dom.className = 'note-organizer note-organizer-banner';
    this.dom.setAttribute('aria-label', t('organizer.title'));
    const unsubscribeState = controller.subscribe(() => this.render()), unsubscribeDismissal = dismissals.subscribe(() => this.render());
    this.unsubscribe = () => { unsubscribeState(); unsubscribeDismissal(); }; this.render();
  }
  private path(): string | null { return this.view.state.field(editorInfoField, false)?.file?.path ?? null; }
  private render(): void {
    if (!this.alive) return;
    const path = this.path(), record = this.controller.recentMoves().find(record => record.id === this.lastMove && record.status === 'done' && record.to === path);
    const entry = this.controller.state().filing.find(entry => entry.path === path && entry.status === 'ready');
    const folder = this.controller.folders().find(folder => folder.id === entry?.proposal?.selected);
    const signature = JSON.stringify([path, entry?.proposal, record, this.busy, path && this.dismissed.has(path)]);
    if (signature === this.signature) return; this.signature = signature; this.plan = null; const generation = ++this.generation;
    this.dom.replaceChildren(); this.dom.hidden = !path || this.dismissed.has(path) || (!record && !folder);
    if (this.dom.hidden) { this.view.requestMeasure(); return; }
    if (record) {
      node(this.dom, 'span', t('organizer.filedAt', { path: record.to }));
      const undo = button(this.dom, t('organizer.undo'), () => { undo.disabled = true; void this.controller.undoMove(record.id).catch(error => { node(this.dom, 'span', errorText(error)); undo.disabled = false; }); });
    } else if (entry && folder) {
      node(this.dom, 'span', t('organizer.banner', { path: folder.path }));
      const accept = button(this.dom, this.busy ? t('organizer.moving') : t('organizer.file'), () => { void this.confirm(); }, true); accept.disabled = true;
      if (!this.busy) void this.controller.prepareMove(entry.path, folder.id).then(plan => {
        if (!this.alive || generation !== this.generation) return;
        this.plan = plan; accept.disabled = false;
      }).catch(error => { if (this.alive && generation === this.generation) node(this.dom, 'span', errorText(error), 'note-organizer-muted'); });
    }
    const dismiss = button(this.dom, '×', () => { if (path) this.dismissed.add(path); this.dismissals.emit(); }); dismiss.setAttribute('aria-label', t('organizer.dismiss'));
    this.view.requestMeasure();
  }
  private async confirm(): Promise<void> {
    const plan = this.plan; if (!plan || this.busy) return;
    this.busy = true; this.render();
    try { await this.controller.confirmMove(plan); this.lastMove = plan.id; this.busy = false; this.render(); }
    catch (error) { this.busy = false; this.render(); node(this.dom, 'span', errorText(error), 'note-organizer-feedback'); }
  }
  update(_update: ViewUpdate): void { this.render(); }
  destroy(): void { this.alive = false; this.generation++; this.unsubscribe(); }
}
