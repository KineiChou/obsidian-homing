import { MarkdownView, Menu, Notice, Plugin, editorInfoField, getLanguage, setIcon } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { ObsidianOrganizer } from './obsidian/controller';
import { registerExplorerIntegration } from './obsidian/explorer-integration';
import { RetiredReviewView, REVIEW_VIEW, LEGACY_REVIEW_VIEW } from './ui/review-view';
import { OrganizerSettingsTab } from './ui/settings-tab';
import { LinkSuggestionsModal } from './ui/link-modal';
import { AnalysisModal } from './ui/analysis-modal';
import { InboxModal } from './ui/inbox-modal';
import { filingPills } from './ui/filing-pill';
import { linkHints } from './ui/link-hints';
import { DestinationPicker, TargetPicker } from './ui/target-picker';
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
    // Earlier versions opened an organizer tab; restored layouts close it instead of showing an error view.
    this.registerView(REVIEW_VIEW, leaf => new RetiredReviewView(leaf, REVIEW_VIEW));
    this.registerView(LEGACY_REVIEW_VIEW, leaf => new RetiredReviewView(leaf, LEGACY_REVIEW_VIEW));
    this.addSettingTab(new OrganizerSettingsTab(this.app, this, organizer));

    const chooseDestination = (choose: (id: string) => void) => new DestinationPicker(this.app, organizer, choose).open();
    const analyze = (paths?: readonly string[]) => new AnalysisModal(this.app, organizer, paths).open();
    const organize = (preselect?: readonly string[]) => new InboxModal(this.app, organizer, { chooseDestination, openNote: path => organizer.openNote(path), analyze }, preselect).open();
    const pills = filingPills(organizer, {
      chooseDestination,
      openNote: (view, path) => this.openBeside(view, path),
      menu: (anchor, items) => {
        const menu = new Menu(); for (const item of items) menu.addItem(value => value.setTitle(item.title).onClick(item.run));
        const rect = anchor.getBoundingClientRect(); menu.showAtPosition({ x: rect.left, y: rect.bottom }, anchor.ownerDocument);
      },
    });
    const hints = linkHints(organizer, {
      sessionId: view => organizer.editors.sessionFor(view)?.id,
      chooseTarget: (proposal, choose) => new TargetPicker(this.app, proposal.input.candidates, target => target.path, target => choose(target.noteId)).open(),
    });
    this.registerEditorExtension([pills.extension, hints.extension]);
    registerExplorerIntegration(this, organizer, { eligible: path => organizer.vault.eligible(path), organize, analyze, chooseDestination });

    const status = this.addStatusBarItem(); status.classList.add('note-organizer-statusbar');
    const open = status.createEl('button', { cls: 'note-organizer-status' }); open.type = 'button';
    const icon = open.createSpan(), count = open.createSpan();
    const links = status.createEl('button', { cls: 'note-organizer-status' }); links.type = 'button';
    this.registerDomEvent(open, 'click', () => organize());
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

    this.addCommand({ id: 'open-review', name: t('command.open'), callback: () => organize() });
    this.addCommand({ id: 'file-note', name: t('command.file'), checkCallback: checking => pills.open(this.app.workspace.getActiveFile()?.path ?? null, checking) });
    this.addCommand({ id: 'analyze-note', name: t('command.analyze'), checkCallback: checking => { const path = this.app.workspace.getActiveFile()?.path; if (!path || !organizer.vault.eligible(path)) return false; if (!checking) organizer.analyzeNote(path); return true; } });
    this.addCommand({ id: 'find-links', name: t('links.find'), callback: () => { void organizer.findLinks().then(() => new LinkSuggestionsModal(this.app, organizer).open()).catch(error => new Notice(errorText(error))); } });
    this.addCommand({ id: 'accept-link', name: t('command.acceptLink'), checkCallback: checking => hints.acceptAtCursor(checking) });
    this.addCommand({ id: 'toggle-automatic', name: t('command.toggle'), callback: () => organizer.setEnabled(!organizer.enabled()) });
    this.app.workspace.onLayoutReady(() => {
      if (this.organizer !== organizer) return;
      for (const type of [REVIEW_VIEW, LEGACY_REVIEW_VIEW]) for (const leaf of this.app.workspace.getLeavesOfType(type)) leaf.detach();
    });
  }
  /** Opens the next inbox note in the same pane, so reviewing the inbox never needs a separate view. */
  private openBeside(view: EditorView, path: string): void {
    const info = view.state.field(editorInfoField, false), file = this.app.vault.getFileByPath(path);
    if (info instanceof MarkdownView && file) void info.leaf.openFile(file);
    else this.organizer?.openNote(path);
  }
  onunload(): void { this.lifecycle++; this.organizer?.dispose(); this.organizer = null; }
}
