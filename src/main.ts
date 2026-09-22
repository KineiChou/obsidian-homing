import { Plugin, Notice } from 'obsidian';
import { ObsidianOrganizer } from './obsidian/controller';
import { OrganizerReviewView, REVIEW_VIEW } from './ui/review-view';
import { OrganizerSettingsTab } from './ui/settings-tab';
import { messageFor } from './core/errors';

export default class NoteOrganizerPlugin extends Plugin {
  private organizer: ObsidianOrganizer | null = null;
  async onload(): Promise<void> {
    const organizer = new ObsidianOrganizer(this);
    try { await organizer.initialize(); } catch (error) { organizer.dispose(); new Notice(messageFor(error)); return; }
    this.organizer = organizer;
    this.registerView(REVIEW_VIEW, leaf => new OrganizerReviewView(leaf, organizer));
    this.addSettingTab(new OrganizerSettingsTab(this.app, this, organizer));
    const status = this.addStatusBarItem();
    const open = status.createEl('button', { text: '整理', cls: 'note-organizer-status' });
    open.type = 'button';
    this.registerDomEvent(open, 'click', () => { void this.openReview(); });
    const update = () => { const state = organizer.state(); const ready = state.filing.some(entry => entry.status === 'ready') || state.links.length > 0; open.textContent = state.network.reason ? '整理 · 分析已暂停' : ready ? '整理 ·' : '整理'; open.setAttribute('aria-label', ready ? '打开整理，有可用建议' : '打开整理'); };
    this.register(organizer.subscribe(update)); update();
    this.addCommand({ id: 'open-review', name: '打开整理建议', callback: () => { void this.openReview(); } });
    this.addCommand({ id: 'analyze-note', name: '分析当前收件箱笔记', checkCallback: checking => { const path = this.app.workspace.getActiveFile()?.path; if (!path || !organizer.vault.eligible(path)) return false; if (!checking) { organizer.analyzeNote(path); void this.openReview(); } return true; } });
    this.addCommand({ id: 'find-links', name: '为当前文字查找链接', callback: () => { void this.openReview(true).then(() => organizer.findLinks()).catch(error => new Notice(messageFor(error))); } });
    this.addCommand({ id: 'toggle-automatic', name: '暂停或恢复自动分析', callback: () => organizer.setEnabled(!organizer.enabled()) });
  }
  private async openReview(current = false): Promise<void> { const leaf = this.app.workspace.getLeavesOfType(REVIEW_VIEW)[0] ?? this.app.workspace.getRightLeaf(false); if (!leaf) return; await leaf.setViewState({ type: REVIEW_VIEW, active: true }); await this.app.workspace.revealLeaf(leaf); if (current && leaf.view instanceof OrganizerReviewView) leaf.view.showCurrent(); }
  onunload(): void { this.organizer?.dispose(); }
}
