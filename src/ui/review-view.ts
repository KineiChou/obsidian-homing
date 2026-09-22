import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { OrganizerController } from './types';
import { ReviewPanel } from './review-panel';
import { TargetPicker } from './target-picker';
import { OrganizerSettingsModal } from './settings-tab';

export const REVIEW_VIEW = 'note-organizer-review';
export class OrganizerReviewView extends ItemView {
  private panel: ReviewPanel | null = null;
  constructor(leaf: WorkspaceLeaf, private readonly controller: OrganizerController) { super(leaf); }
  getViewType(): string { return REVIEW_VIEW; }
  getDisplayText(): string { return '整理'; }
  getIcon(): string { return 'inbox'; }
  showCurrent(): void { this.panel?.showCurrent(); }
  async onOpen(): Promise<void> {
    this.contentEl.replaceChildren();
    this.panel = new ReviewPanel(this.contentEl, this.controller, {
      settings: () => new OrganizerSettingsModal(this.app, this.controller).open(),
      folder: choose => new TargetPicker(this.app, this.controller.folders(), folder => folder.path, folder => choose(folder.id)).open(),
      target: (proposal, choose) => new TargetPicker(this.app, proposal.input.candidates, target => target.path, target => choose(target.noteId)).open(),
    });
  }
  async onClose(): Promise<void> { this.panel?.destroy(); this.panel = null; }
}
