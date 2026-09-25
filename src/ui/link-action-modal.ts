import { App, FuzzySuggestModal, Notice } from 'obsidian';
import type { LinkMention, OrganizerController } from './types';
import type { CursorTarget } from './link-hints';
import { errorText, t } from '../i18n';

type Action = { text: string; run: () => void };
const breadcrumb = (path: string) => path.replace(/\.md$/, '').split('/').join(' › ');

/**
 * Keyboard-first actions for the link or suggestion under the cursor, opened by the `link-menu` command
 * (and so bindable from a Vim leader mapping). Writes go through the same confirmed-plan path as the hover card.
 */
export class LinkActionModal extends FuzzySuggestModal<Action> {
  /** The model's pick for an ambiguous mention; `null` when it found no fitting note. */
  private verdict: number | null | undefined;
  private closed = false;
  constructor(app: App, private readonly controller: OrganizerController, private readonly target: CursorTarget) {
    super(app);
    this.setPlaceholder(target.kind === 'link' ? t('linkMenu.linkPlaceholder', { text: target.link.display }) : t('linkMenu.placeholder', { text: target.mention.text }));
  }
  onOpen(): void {
    void super.onOpen();
    const target = this.target;
    // An ambiguous mention is checked once, as on hover; the list re-sorts when the answer arrives.
    if (target.kind !== 'mention' || target.mention.tier === 'confident' || target.mention.verified !== undefined || !this.controller.settings().verifyOnHover) return;
    this.setPlaceholder(t('hint.checking'));
    const finish = (placeholder: string) => { if (!this.closed) { this.setPlaceholder(placeholder); this.inputEl.dispatchEvent(new Event('input')); } };
    void this.controller.verifyLink(target.session, target.mention).then(selected => {
      this.verdict = selected;
      finish(selected === null ? t('hint.noLink') : t('linkMenu.placeholder', { text: target.mention.text }));
    }, error => finish(errorText(error)));
  }
  onClose(): void { this.closed = true; super.onClose(); }
  getItems(): Action[] {
    const target = this.target;
    if (target.kind === 'link') return [{ text: t('linkMenu.unlink', { text: target.link.display }), run: () => this.controller.removeLink(target.session, target.link) }];
    const mention = target.mention, recommended = this.recommended(mention);
    const candidates = [...mention.candidates].sort((a, b) => Number(b.target.noteId === recommended) - Number(a.target.noteId === recommended));
    return [
      ...candidates.map(candidate => ({
        text: t(candidate.target.noteId === recommended ? 'linkMenu.linkRecommended' : 'linkMenu.link', { path: breadcrumb(candidate.target.path) }),
        run: () => this.link(mention, candidate.target.noteId),
      })),
      { text: t('linkMenu.ignore'), run: () => this.controller.dismissLink(this.controller.linkProposalFor(target.session, mention)) },
      { text: t('hint.never', { term: mention.text }), run: () => { void this.controller.ignoreLinkTerm(mention.text).catch(error => new Notice(errorText(error))); } },
    ];
  }
  getItemText(item: Action): string { return item.text; }
  onChooseItem(item: Action): void {
    try { item.run(); } catch (error) { new Notice(errorText(error)); }
  }
  private recommended(mention: LinkMention): number | undefined {
    if (mention.verified !== undefined) return mention.verified;
    if (this.verdict !== undefined) return this.verdict ?? undefined;
    return mention.tier === 'confident' ? mention.candidates[0]?.target.noteId : undefined;
  }
  private link(mention: LinkMention, noteId: number): void {
    if (this.target.kind !== 'mention') return;
    const proposal = this.controller.linkProposalFor(this.target.session, mention, noteId);
    const failure = this.controller.confirmLinks([this.controller.prepareLink(proposal, noteId)]).failures[0];
    if (failure) throw failure.error;
  }
}
