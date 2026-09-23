import { Component, ItemView, MarkdownRenderer, Menu, WorkspaceLeaf } from 'obsidian';
import type { OrganizerController } from './types';
import { ReviewPanel } from './review-panel';
import { DestinationPicker } from './target-picker';
import { OrganizerSettingsModal } from './settings-tab';
import { AnalysisModal } from './analysis-modal';
import { t } from '../i18n';

export const REVIEW_VIEW = 'note-organizer-inbox';
export const LEGACY_REVIEW_VIEW = 'note-organizer-review';
export class OrganizerReviewView extends ItemView {
  private panel: ReviewPanel | null = null;
  constructor(leaf: WorkspaceLeaf, private readonly controller: OrganizerController, private readonly viewType = REVIEW_VIEW) { super(leaf); }
  getViewType(): string { return this.viewType; }
  getDisplayText(): string { return t('organizer.title'); }
  getIcon(): string { return 'inbox'; }
  async onOpen(): Promise<void> {
    this.contentEl.replaceChildren();
    this.panel = new ReviewPanel(this.contentEl, this.controller, {
      settings: () => new OrganizerSettingsModal(this.app, this.controller).open(),
      folder: choose => new DestinationPicker(this.app, this.controller, choose).open(),
      analyze: paths => new AnalysisModal(this.app, this.controller, paths).open(),
      preview: async (text, container, path) => {
        const component = new Component(); this.addChild(component);
        try { await MarkdownRenderer.render(this.app, text, container, path, component); }
        catch (error) { this.removeChild(component); throw error; }
        return () => { this.removeChild(component); };
      },
      menu: (anchor, items) => {
        const menu = new Menu(); for (const item of items) menu.addItem(value => value.setTitle(item.title).onClick(item.run));
        const rect = anchor.getBoundingClientRect(); menu.showAtPosition({ x: rect.left, y: rect.bottom });
      },
    });
  }
  async onClose(): Promise<void> { this.panel?.destroy(); this.panel = null; }
}
