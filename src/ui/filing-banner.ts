import { editorInfoField } from 'obsidian';
import { showPanel, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { OrganizerController } from './types';
import type { MovePlan } from '../filing/types';
import { button, node } from './dom';
import { Emitter } from '../core/events';
import { errorText, t } from '../i18n';

type ChooseDestination = (choose: (id: string) => void) => void;
interface ManualDestination { readonly proposalId: string; readonly id: string }
export function filingBanner(controller: OrganizerController, chooseDestination: ChooseDestination): Extension {
  const dismissed = new Set<string>(), destinations = new Map<string, ManualDestination>(), changes = new Emitter();
  return showPanel.of(view => new FilingBanner(view, controller, chooseDestination, dismissed, destinations, changes));
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
  private previousPath: string | null;
  constructor(private readonly view: EditorView, private readonly controller: OrganizerController, private readonly chooseDestination: ChooseDestination, private readonly dismissed: Set<string>, private readonly destinations: Map<string, ManualDestination>, private readonly changes: Emitter) {
    this.dom = view.dom.ownerDocument.createElement('div'); this.dom.className = 'note-organizer note-organizer-banner';
    this.dom.setAttribute('aria-label', t('organizer.title'));
    this.previousPath = this.path();
    const unsubscribeState = controller.subscribe(() => this.render()), unsubscribeDismissal = changes.subscribe(() => this.render());
    this.unsubscribe = () => { unsubscribeState(); unsubscribeDismissal(); }; this.render();
  }
  private path(): string | null { return this.view.state.field(editorInfoField, false)?.file?.path ?? null; }
  private render(): void {
    if (!this.alive) return;
    const path = this.path(), record = this.controller.recentMoves().find(record => record.id === this.lastMove && record.status === 'done' && record.to === path);
    const entry = this.controller.state().filing.find(entry => entry.path === path && entry.status === 'ready');
    const manual = path ? this.destinations.get(path) : undefined;
    const target = manual?.proposalId === entry?.proposal?.id ? manual?.id : entry?.proposal?.selected;
    const folder = this.controller.folders().find(folder => folder.id === target);
    const signature = JSON.stringify([path, entry?.proposal, folder, record, this.busy, path && this.dismissed.has(path)]);
    if (signature === this.signature) return; this.signature = signature; this.plan = null; const generation = ++this.generation;
    this.dom.replaceChildren(); this.dom.hidden = !path || this.dismissed.has(path) || (!record && !folder);
    if (this.dom.hidden) { this.view.requestMeasure(); return; }
    if (record) {
      node(this.dom, 'span', t('organizer.filedAt', { path: record.to }));
      const undo = button(this.dom, t('organizer.undo'), () => { undo.disabled = true; void this.controller.undoMove(record.id).catch(error => { node(this.dom, 'span', errorText(error)); undo.disabled = false; }); });
    } else if (entry && folder) {
      node(this.dom, 'span', t('organizer.banner', { path: folder.path }));
      const accept = button(this.dom, this.busy ? t('organizer.moving') : t('organizer.file'), () => { void this.confirm(); }, true); accept.disabled = true;
      const change = button(this.dom, t('organizer.choose'), () => this.chooseDestination(id => {
        const current = this.controller.state().filing.find(item => item.path === path && item.status === 'ready');
        if (!this.alive || this.path() !== path || !path || !current?.proposal || current.proposal.id !== entry.proposal?.id) return;
        this.destinations.set(path, { id, proposalId: current.proposal.id }); this.changes.emit();
      })); change.disabled = this.busy;
      if (!this.busy) void this.controller.prepareMove(entry.path, folder.id).then(plan => {
        if (!this.alive || generation !== this.generation) return;
        this.plan = plan; accept.disabled = false;
      }).catch(error => { if (this.alive && generation === this.generation) node(this.dom, 'span', errorText(error), 'note-organizer-muted'); });
    }
    const dismiss = button(this.dom, '×', () => { if (path) this.dismissed.add(path); this.changes.emit(); }); dismiss.setAttribute('aria-label', t('organizer.dismiss'));
    this.view.requestMeasure();
  }
  private async confirm(): Promise<void> {
    const plan = this.plan; if (!plan || this.busy) return;
    this.busy = true; this.render();
    try { await this.controller.confirmMove(plan); this.lastMove = plan.id; this.busy = false; this.render(); }
    catch (error) { this.busy = false; this.render(); node(this.dom, 'span', errorText(error), 'note-organizer-feedback'); }
  }
  update(_update: ViewUpdate): void { const path = this.path(); if (path !== this.previousPath) this.lastMove = null; this.previousPath = path; this.render(); }
  destroy(): void { this.alive = false; this.generation++; this.unsubscribe(); }
}
