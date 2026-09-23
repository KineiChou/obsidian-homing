import { Plugin, Notice, getLanguage, setIcon, type WorkspaceLeaf } from 'obsidian';
import { ObsidianOrganizer } from './obsidian/controller';
import { OrganizerReviewView, REVIEW_VIEW, LEGACY_REVIEW_VIEW } from './ui/review-view';
import { OrganizerSettingsTab } from './ui/settings-tab';
import { LinkSuggestionsModal } from './ui/link-modal';
import { filingBanner } from './ui/filing-banner';
import { errorText, setLocale, t } from './i18n';

export default class NoteOrganizerPlugin extends Plugin {
  private organizer: ObsidianOrganizer | null = null;
  private lifecycle = 0;
  async onload(): Promise<void> {
    const lifecycle = ++this.lifecycle;
    setLocale(getLanguage());
    const organizer = new ObsidianOrganizer(this);
    this.organizer = organizer;
    try { await organizer.initialize(); }
    catch (error) { organizer.dispose(); if (this.lifecycle === lifecycle) { this.organizer = null; new Notice(errorText(error)); } return; }
    if (this.lifecycle !== lifecycle || this.organizer !== organizer) { organizer.dispose(); return; }
    this.registerView(REVIEW_VIEW, leaf => new OrganizerReviewView(leaf, organizer));
    this.registerView(LEGACY_REVIEW_VIEW, leaf => new OrganizerReviewView(leaf, organizer, LEGACY_REVIEW_VIEW));
    this.addSettingTab(new OrganizerSettingsTab(this.app, this, organizer));
    this.registerEditorExtension(filingBanner(organizer));
    const status = this.addStatusBarItem(); status.classList.add('note-organizer-statusbar');
    const open = status.createEl('button', { cls: 'note-organizer-status' }); open.type = 'button';
    const icon = open.createSpan(), count = open.createSpan();
    const links = status.createEl('button', { cls: 'note-organizer-status' }); links.type = 'button';
    this.registerDomEvent(open, 'click', () => { void this.openReview(); });
    this.registerDomEvent(links, 'click', () => new LinkSuggestionsModal(this.app, organizer).open());
    const update = () => {
      const state = organizer.state(), ready = state.filing.filter(entry => entry.status === 'ready').length;
      const paused = !!state.network.reason || !organizer.enabled();
      const label = paused ? t('organizer.pause') : t('organizer.suggestions', { count: ready });
      setIcon(icon, paused ? 'pause' : 'inbox'); count.textContent = ready ? String(ready) : ''; open.setAttribute('aria-label', label); open.title = label;
      const linkCount = state.links.filter(link => link.input.anchor.sourcePath === state.activePath).length;
      links.hidden = linkCount === 0; links.textContent = t('links.count', { count: linkCount }); links.setAttribute('aria-label', t('links.title'));
    };
    this.register(organizer.subscribe(update)); update();
    this.addCommand({ id: 'open-review', name: t('command.open'), callback: () => { void this.openReview(); } });
    this.addCommand({ id: 'analyze-note', name: t('command.analyze'), checkCallback: checking => { const path = this.app.workspace.getActiveFile()?.path; if (!path || !organizer.vault.eligible(path)) return false; if (!checking) { organizer.analyzeNote(path); void this.openReview(); } return true; } });
    this.addCommand({ id: 'find-links', name: t('links.find'), callback: () => { void organizer.findLinks().then(() => new LinkSuggestionsModal(this.app, organizer).open()).catch(error => new Notice(errorText(error))); } });
    this.addCommand({ id: 'toggle-automatic', name: t('command.toggle'), callback: () => organizer.setEnabled(!organizer.enabled()) });
    this.app.workspace.onLayoutReady(() => {
      if (this.organizer !== organizer) return;
      for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_VIEW)) if (!(leaf.view instanceof OrganizerReviewView)) void this.refreshReview(leaf).catch(error => new Notice(errorText(error)));
      const legacy = this.app.workspace.getLeavesOfType(LEGACY_REVIEW_VIEW);
      if (!legacy.length) return;
      for (const leaf of legacy) leaf.detach();
      void this.openReview();
    });
  }
  private async openReview(): Promise<void> {
    const lifecycle = this.lifecycle;
    if (!this.organizer) return;
    const leaf = this.app.workspace.getLeavesOfType(REVIEW_VIEW)[0] ?? this.app.workspace.getLeaf('tab');
    if (await this.refreshReview(leaf) && lifecycle === this.lifecycle) await this.app.workspace.revealLeaf(leaf);
  }
  private async refreshReview(leaf: WorkspaceLeaf): Promise<boolean> {
    const lifecycle = this.lifecycle, organizer = this.organizer;
    const current = () => !!organizer && this.organizer === organizer && this.lifecycle === lifecycle;
    if (!current()) return false;
    // Hot reload can retain a view from the previous plugin instance. Recreate its controller binding.
    if (leaf.view.getViewType() === REVIEW_VIEW && !(leaf.view instanceof OrganizerReviewView)) {
      await leaf.setViewState({ type: 'empty' });
      if (!current()) return false;
    }
    await leaf.setViewState({ type: REVIEW_VIEW });
    return current();
  }
  onunload(): void { this.lifecycle++; this.organizer?.dispose(); this.organizer = null; }
}
