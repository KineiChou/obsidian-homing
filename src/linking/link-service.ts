import { OrganizerError } from '../core/errors';
import type { EditorPort, LinkHost, LinkPlan, LinkProposal, LinkService, LinkTarget, MetadataIndex, TextAnchor } from './types';
import { graphemeBoundaries } from './text-boundaries';

export class ConfirmedLinkService implements LinkService {
  private readonly plans = new Map<string, LinkPlan>();
  private sequence = 0;
  constructor(private readonly index: MetadataIndex, private readonly host: LinkHost) {}

  prepare(proposal: LinkProposal, targetId: number): LinkPlan {
    if (proposal.context.settingsRevision !== this.host.settingsRevision() || proposal.input.catalogueEpoch !== this.index.epoch) this.stale();
    const offered = proposal.input.candidates.find(target => target.noteId === targetId);
    const target = this.index.get(targetId);
    if (!offered || !target || !this.sameTarget(offered, target)) this.stale();
    const anchor = Object.freeze({ ...proposal.input.anchor });
    this.validate(anchor, target);
    const replacement = this.host.generateLink(target, anchor.sourcePath, anchor.originalText);
    if (!replacement || replacement === anchor.originalText || !this.host.resolvesTo(replacement, anchor.sourcePath, target)) {
      throw new OrganizerError('unsafe', '无法安全生成指向该笔记的链接。');
    }
    const plan: LinkPlan = Object.freeze({ id: `link-plan-${++this.sequence}`, proposalId: proposal.id, anchor,
      target: Object.freeze({ ...target, aliases: Object.freeze([...target.aliases]), tags: Object.freeze([...target.tags]) }),
      replacement, catalogueEpoch: this.index.epoch, settingsRevision: this.host.settingsRevision() });
    this.plans.set(plan.id, plan);
    if (this.plans.size > 128) this.plans.delete(this.plans.keys().next().value!);
    return plan;
  }

  confirm(planId: string): void {
    const plan = this.plans.get(planId);
    if (!plan) this.stale();
    this.plans.delete(planId);
    if (plan.catalogueEpoch !== this.index.epoch || plan.settingsRevision !== this.host.settingsRevision()) this.stale();
    const target = this.index.get(plan.target.noteId);
    if (!target || !this.sameTarget(plan.target, target)) this.stale();
    const editor = this.validate(plan.anchor, target);
    if (!this.host.resolvesTo(plan.replacement, plan.anchor.sourcePath, target)) {
      throw new OrganizerError('unsafe', '链接目标已改变，请重新查找。');
    }
    editor.replace(plan.anchor.from, plan.anchor.to, plan.replacement);
    editor.suppress(plan.anchor, target.noteId);
  }

  private validate(anchor: TextAnchor, target: LinkTarget): EditorPort {
    const editor = this.host.editor(anchor.editorSessionId);
    const snapshot = editor?.snapshot();
    if (!editor || !snapshot || snapshot.sessionId !== anchor.editorSessionId || snapshot.noteId !== anchor.noteId ||
        snapshot.path !== anchor.sourcePath || snapshot.revision !== anchor.documentRevision || target.noteId === anchor.noteId ||
        snapshot.linkedNoteIds.has(target.noteId) || !this.host.allowed(target)) this.stale();
    const localFrom = anchor.from - anchor.contextFrom, localTo = anchor.to - anchor.contextFrom;
    const boundaries = graphemeBoundaries(anchor.contextText);
    if (!Number.isInteger(anchor.from) || !Number.isInteger(anchor.to) || anchor.contextFrom < 0 ||
        anchor.from < anchor.contextFrom || anchor.to <= anchor.from || localTo > anchor.contextText.length ||
        !boundaries.has(localFrom) || !boundaries.has(localTo) ||
        anchor.contextText.slice(localFrom, localTo) !== anchor.originalText ||
        editor.read(anchor.from, anchor.to) !== anchor.originalText ||
        editor.read(anchor.contextFrom, anchor.contextFrom + anchor.contextText.length) !== anchor.contextText ||
        !editor.allows(anchor.from, anchor.to)) this.stale();
    return editor;
  }

  private sameTarget(a: LinkTarget, b: LinkTarget): boolean {
    return a.noteId === b.noteId && a.revision === b.revision && a.path === b.path && a.title === b.title &&
      a.description === b.description && a.aliases.length === b.aliases.length && a.tags.length === b.tags.length &&
      a.aliases.every((alias, i) => alias === b.aliases[i]) && a.tags.every((tag, i) => tag === b.tags[i]);
  }
  private stale(): never { throw new OrganizerError('stale', '这条链接建议已过期，请重新查找。'); }
}
