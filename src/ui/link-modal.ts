import { App, Modal } from 'obsidian';
import type { OrganizerController } from './types';
import type { LinkPlan, LinkProposal } from '../linking/types';
import { button, node } from './dom';
import { TargetPicker } from './target-picker';
import { errorText, t } from '../i18n';

export class LinkSuggestionsModal extends Modal {
  private unsubscribe: (() => void) | undefined;
  private readonly plans = new Map<string, LinkPlan>();
  private readonly checked = new Set<string>();
  private readonly rows = new Map<string, { element: HTMLElement; status: HTMLElement; check: HTMLInputElement; proposal: LinkProposal }>();
  private submit!: HTMLButtonElement;
  private busy = false;
  private alive = false;
  constructor(app: App, private readonly controller: OrganizerController) { super(app); }
  onOpen(): void {
    this.alive = true; this.setTitle(t('links.title')); this.contentEl.classList.add('note-organizer', 'note-organizer-link-modal');
    const state = this.controller.state();
    const source = state.activePath ?? state.links[0]?.input.anchor.sourcePath;
    const session = state.links.find(proposal => proposal.input.anchor.sourcePath === source)?.input.anchor.editorSessionId;
    const proposals = state.links.filter(proposal => proposal.input.anchor.editorSessionId === session);
    if (!proposals.length) node(this.contentEl, 'p', t('links.empty'));
    const list = node(this.contentEl, 'div', undefined, 'note-organizer-batch-list');
    const footer = node(this.contentEl, 'footer', undefined, 'note-organizer-actions');
    this.submit = button(footer, '', () => this.confirm(), true); button(footer, t('batch.cancel'), () => this.close());
    for (const proposal of proposals) {
      const row = node(list, 'section', undefined, 'note-organizer-link-row'), anchor = proposal.input.anchor;
      const label = node(row, 'label', undefined, 'note-organizer-check-row'), check = node(label, 'input'); check.type = 'checkbox';
      const context = node(label, 'span'); const from = anchor.from - anchor.contextFrom, to = anchor.to - anchor.contextFrom;
      context.append(this.contentEl.ownerDocument.createTextNode(anchor.contextText.slice(0, from))); node(context, 'mark', anchor.originalText); context.append(this.contentEl.ownerDocument.createTextNode(anchor.contextText.slice(to)));
      const destination = node(row, 'p', '', 'note-organizer-path');
      const status = node(row, 'p', '', 'note-organizer-feedback'); status.setAttribute('role', 'status');
      this.rows.set(proposal.id, { element: row, status, check, proposal });
      const prepare = (targetId: number) => {
        try {
          const plan = this.controller.prepareLink(proposal, targetId); this.plans.set(proposal.id, plan); destination.textContent = plan.target.path;
          check.disabled = false; check.checked = true; this.checked.add(proposal.id); check.setAttribute('aria-label', t('links.select', { text: anchor.originalText, path: plan.target.path })); status.textContent = '';
        } catch (error) { this.plans.delete(proposal.id); this.checked.delete(proposal.id); check.checked = false; check.disabled = true; status.textContent = errorText(error); }
        this.updateButton();
      };
      if (proposal.selected !== null) prepare(proposal.selected);
      check.addEventListener('change', () => { if (check.checked) this.checked.add(proposal.id); else this.checked.delete(proposal.id); this.updateButton(); });
      button(row, t('links.change'), () => new TargetPicker(this.app, proposal.input.candidates, target => target.path, target => { if (this.alive) prepare(target.noteId); }).open());
    }
    this.updateButton();
    this.unsubscribe = this.controller.subscribe(() => {
      if (this.busy) return;
      const current = this.controller.state().links;
      for (const [id, row] of this.rows) {
        const latest = current.find(proposal => proposal.id === id);
        if (latest && latest.input.anchor.documentRevision === row.proposal.input.anchor.documentRevision) continue;
        this.plans.delete(id); this.checked.delete(id); row.check.checked = false; row.check.disabled = true; row.status.textContent = t('links.stale');
      }
      this.updateButton();
    });
  }
  private updateButton(): void { this.submit.textContent = t('links.add', { count: this.checked.size }); this.submit.disabled = this.busy || this.checked.size === 0; }
  private confirm(): void {
    if (this.busy) return; this.busy = true; this.updateButton();
    const selected = [...this.checked].flatMap(id => { const plan = this.plans.get(id); return plan ? [plan] : []; });
    try {
      const result = this.controller.confirmLinks(selected);
      for (const plan of selected) {
        const row = this.rows.get(plan.proposalId)!; row.check.checked = false; this.checked.delete(plan.proposalId); this.plans.delete(plan.proposalId); row.check.disabled = true;
        const failure = result.failures.find(item => item.planId === plan.id);
        row.status.textContent = failure ? errorText(failure.error) : t('links.applied');
      }
      if (result.appliedPlanIds.length) node(this.contentEl, 'p', t('links.added', { count: result.appliedPlanIds.length }));
    } catch (error) { node(this.contentEl, 'p', errorText(error)); }
    this.busy = false; this.updateButton();
  }
  onClose(): void { this.alive = false; this.unsubscribe?.(); this.plans.clear(); this.checked.clear(); this.rows.clear(); }
}
