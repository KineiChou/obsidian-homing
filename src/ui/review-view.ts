import { ItemView, WorkspaceLeaf } from 'obsidian';

export const REVIEW_VIEW = 'note-organizer-inbox';
export const LEGACY_REVIEW_VIEW = 'note-organizer-review';
/** Placeholder for organizer tabs saved by earlier versions; it closes itself when restored. */
export class RetiredReviewView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly viewType: string) { super(leaf); }
  getViewType(): string { return this.viewType; }
  getDisplayText(): string { return 'Note Organizer'; }
  async onOpen(): Promise<void> { window.setTimeout(() => this.leaf.detach(), 0); }
}
