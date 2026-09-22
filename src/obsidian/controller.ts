import { Plugin, TFile, TFolder, requestUrl, parseLinktext } from 'obsidian';
import { Emitter } from '../core/events';
import { messageFor, OrganizerError } from '../core/errors';
import { within } from '../core/paths';
import { parseSettings, type OrganizerSettings } from '../settings';
import { MemoryFolderCatalog } from '../folders/catalog';
import { PluginStateStore } from '../storage/state-store';
import { StableInboxQueue } from '../filing/inbox-queue';
import { ConfirmedMoveService } from '../filing/move-service';
import { MixedDepthClassifier } from '../filing/classifier';
import { JevClient } from '../jev/client';
import { SharedDecisionScheduler } from '../jev/scheduler';
import { MemoryMetadataIndex } from '../linking/metadata-index';
import { LocalMentionMatcher } from '../linking/mention-matcher';
import { JevLinkRecommender } from '../linking/recommender';
import { ConfirmedLinkService } from '../linking/link-service';
import type { OrganizerController, ReviewState } from '../ui/types';
import type { LinkPlan, LinkProposal } from '../linking/types';
import type { MovePlan } from '../filing/types';
import { EditorSessions } from './editor-extension';
import { VaultAdapter } from './vault-adapter';

export class ObsidianOrganizer implements OrganizerController {
  readonly events = new Emitter();
  readonly store: PluginStateStore;
  readonly index = new MemoryMetadataIndex();
  readonly catalog = new MemoryFolderCatalog();
  readonly vault: VaultAdapter;
  readonly editors: EditorSessions;
  private scheduler!: SharedDecisionScheduler;
  private queue!: StableInboxQueue;
  private moves!: ConfirmedMoveService;
  private linker!: ConfirmedLinkService;
  private recommender!: JevLinkRecommender;
  private links: readonly LinkProposal[] = [];
  private revision = 0;
  private generation = 0;
  private ready = false;
  private disposed = false;
  private message: string | null = null;
  private activePath: string | null = null;
  constructor(private readonly plugin: Plugin) {
    this.store = new PluginStateStore({ load: () => plugin.loadData(), save: data => plugin.saveData(data), loadLocal: key => plugin.app.loadLocalStorage(key), saveLocal: (key, value) => plugin.app.saveLocalStorage(key, value) });
    this.vault = new VaultAdapter(plugin.app, this.index, () => this.settings());
    this.editors = new EditorSessions({
      identity: path => this.vault.id(path), linkedTargets: (path, text) => this.vault.linkedTargets(path, text),
      changed: (session, path) => { this.scheduler?.cancel('link:' + session); this.links = this.links.filter(link => link.input.anchor.editorSessionId !== session); this.message = null; if (this.vault.eligible(path)) this.queue?.touch(path, true); this.events.emit(); },
      idle: session => { if (this.enabled() && this.settings().autoLinks) void this.analyzeLinks(session, true); },
    });
  }
  async initialize(): Promise<void> {
    await this.store.load();
    const client = new JevClient({ post: async (url, headers, body) => {
      try { const response = await requestUrl({ url, method: 'POST', headers: { ...headers }, body, throw: false }); return { status: response.status, headers: response.headers, json: response.json }; }
      catch { throw new OrganizerError('network', '暂时无法连接 Jev，请稍后重试。'); }
    } }, { get: () => this.plugin.app.secretStorage.getSecret(this.settings().secretName) });
    this.scheduler = new SharedDecisionScheduler(client, this.store.usage, () => this.settings().dailyRequestLimit);
    const classifier = new MixedDepthClassifier(this.scheduler);
    this.queue = new StableInboxQueue({
      eligible: path => this.vault.eligible(path), automaticEnabled: () => this.enabled() && this.settings().autoFiling,
      isEditing: path => this.editors.editing(path), persist: entries => this.store.updateQueue(entries),
      propose: async (path, automatic, isCurrent) => {
        const note = await this.vault.note(path, !automatic), folders = this.catalog.snapshot(), settings = this.revision;
        return classifier.propose(note, folders, this.context(), { key: 'filing:' + path, priority: automatic ? 'filing' : 'manual', automatic, isCurrent: () => !this.disposed && isCurrent() && this.revision === settings && this.catalog.snapshot().revision === folders.revision && this.vault.eligible(path) });
      },
    });
    this.moves = new ConfirmedMoveService({ source: path => this.vault.source(path), currentPath: id => this.vault.currentPath(id), exists: path => Boolean(this.plugin.app.vault.getAbstractFileByPath(path)), eligible: path => this.vault.eligible(path), referencesSafe: (path, destination) => this.vault.referencesSafe(path, destination), rename: (from, to) => this.vault.rename(from, to), folders: () => this.catalog.snapshot(), settingsRevision: () => this.revision }, this.store.journal);
    this.recommender = new JevLinkRecommender(this.scheduler);
    const app = this.plugin.app;
    this.linker = new ConfirmedLinkService(this.index, {
      editor: id => this.editors.get(id)?.forConfirmation(), settingsRevision: () => this.revision,
      allowed: target => this.vault.allowed(target.path),
      generateLink: (target, source, alias) => { const file = this.vault.file(target.path); if (!file) throw new OrganizerError('missing', '链接目标已不存在。'); return app.fileManager.generateMarkdownLink(file, source, undefined, alias); },
      resolvesTo: (link, source, target) => {
        const match = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(link) ?? /^\[[^\]]*\]\(([^)]+)\)$/.exec(link.trim());
        if (!match?.[1]) return false;
        let path = match[1]; try { path = decodeURI(path); } catch { return false; }
        return app.metadataCache.getFirstLinkpathDest(parseLinktext(path).path, source)?.path === target.path;
      },
    });
    this.refreshFolders();
    this.queue.restore(this.store.snapshot().filingQueue);
    await this.moves.recover();
    this.plugin.register(this.queue.subscribe(() => this.events.emit()));
    this.plugin.register(this.scheduler.subscribe(() => this.events.emit()));
    this.plugin.registerEditorExtension(this.editors.extension);
    this.plugin.app.workspace.onLayoutReady(() => { if (!this.disposed) this.start(); });
  }
  private start(): void {
    const { vault, metadataCache, workspace } = this.plugin.app;
    this.plugin.registerEvent(vault.on('create', file => { if (file instanceof TFolder) this.refreshFolders(); else if (file instanceof TFile) { this.vault.metadata(file); if (this.vault.eligible(file.path)) this.queue.touch(file.path, true); } }));
    this.plugin.registerEvent(vault.on('modify', file => { if (file instanceof TFile) { this.vault.touch(file); this.vault.metadata(file); this.invalidateLinks(); if (this.vault.eligible(file.path)) this.queue.touch(file.path, true); } }));
    this.plugin.registerEvent(metadataCache.on('changed', file => { this.vault.metadata(file); this.invalidateLinks(); }));
    this.plugin.registerEvent(vault.on('rename', (file, oldPath) => {
      if (file instanceof TFolder) {
        for (const entry of this.queue.entries()) if (within(entry.path, oldPath)) this.queue.rename(entry.path, file.path + entry.path.slice(oldPath.length));
        for (const note of vault.getMarkdownFiles()) if (within(note.path, file.path)) { this.vault.touch(note); this.vault.metadata(note); }
        if (within(this.settings().inbox, oldPath)) void this.saveSettings({ ...this.settings(), inbox: file.path + this.settings().inbox.slice(oldPath.length) }).catch(error => this.report(error));
        this.refreshFolders();
      } else if (file instanceof TFile) { this.vault.touch(file); this.vault.metadata(file); this.queue.rename(oldPath, file.path); if (this.vault.eligible(file.path)) this.queue.touch(file.path, true); }
      this.invalidateLinks();
    }));
    this.plugin.registerEvent(vault.on('delete', file => {
      if (file instanceof TFile) { this.vault.remove(file); this.queue.remove(file.path); }
      else { for (const entry of this.queue.entries()) if (within(entry.path, file.path)) this.queue.remove(entry.path); this.refreshFolders(); }
      this.invalidateLinks();
    }));
    this.plugin.registerEvent(workspace.on('file-open', file => { this.activePath = file?.path ?? null; this.links = []; this.events.emit(); }));
    this.activePath = workspace.getActiveFile()?.path ?? null;
    void this.buildIndex();
  }
  private async buildIndex(): Promise<void> {
    const generation = ++this.generation;
    this.ready = false;
    const files = this.plugin.app.vault.getMarkdownFiles();
    let cursor = 0;
    while (cursor < files.length && !this.disposed && generation === this.generation) {
      const started = performance.now(); let count = 0;
      while (cursor < files.length && count++ < 250 && performance.now() - started < 4) {
        const file = files[cursor++];
        if (file && this.vault.file(file.path) === file) this.vault.metadata(file);
      }
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    if (!this.disposed && generation === this.generation) { this.ready = true; this.events.emit(); }
  }
  private refreshFolders(): void { this.catalog.refresh(this.vault.allFolders(), this.settings()); this.queue?.invalidate(); this.events.emit(); }
  private invalidateLinks(): void {
    this.links = this.links.filter(proposal => proposal.input.catalogueEpoch === this.index.epoch && proposal.input.candidates.every(target => this.index.get(target.noteId)?.revision === target.revision));
    this.events.emit();
  }
  private context() { return { taskId: crypto.randomUUID(), settingsRevision: this.revision, promptRevision: 1, modelId: this.settings().modelId }; }
  state(): ReviewState { return { filing: this.queue.entries(), links: this.links, activePath: this.activePath, network: this.scheduler.status(), indexReady: this.ready, message: this.message }; }
  subscribe(listener: () => void) { return this.events.subscribe(listener); }
  settings(): OrganizerSettings { return this.store.snapshot().settings; }
  enabled(): boolean { return this.store.automaticEnabled(); }
  setEnabled(enabled: boolean): void { this.store.setAutomaticEnabled(enabled); this.queue.invalidate(); this.events.emit(); }
  async saveSettings(value: OrganizerSettings): Promise<void> {
    const settings = parseSettings(value);
    await this.store.updateSettings(settings); this.revision++; this.links = [];
    this.refreshFolders(); this.index.clear(); void this.buildIndex();
  }
  usage() { return this.store.usage.read(); }
  folders() { return this.catalog.snapshot().targets; }
  allFolders() { return this.vault.allFolders(); }
  async createInbox(path: string): Promise<void> { const validated = parseSettings({ ...this.settings(), inbox: path }); if (!this.plugin.app.vault.getAbstractFileByPath(validated.inbox)) await this.plugin.app.vault.createFolder(validated.inbox); await this.saveSettings(validated); }
  analyzeInbox(): void { for (const file of this.plugin.app.vault.getMarkdownFiles()) if (this.vault.eligible(file.path)) this.queue.analyze(file.path); }
  analyzeNote(path: string): void { this.queue.analyze(path); }
  ignoreNote(path: string): void { this.scheduler.cancel('filing:' + path); this.queue.ignore(path); }
  restoreIgnored(): void { for (const entry of this.queue.entries()) if (entry.status === 'ignored') this.queue.resume(entry.path); }
  async prepareMove(path: string, target: string): Promise<MovePlan> {
    const entry = this.queue.entries().find(item => item.path === path), proposal = entry?.proposal;
    const plan = await this.moves.prepare(path, target);
    if (proposal && (proposal.source.contentHash !== plan.source.contentHash || proposal.source.revision !== plan.source.revision || proposal.foldersRevision !== plan.foldersRevision || proposal.context.settingsRevision !== this.revision)) throw new OrganizerError('stale', '建议已过期，请重新分析。');
    return plan;
  }
  async confirmMove(plan: MovePlan): Promise<void> {
    this.queue.mark(plan.source.path, 'moving');
    const result = await this.moves.confirm(plan.id);
    if (result.status === 'done') this.queue.mark(plan.source.path, 'done', '已归档', result.record.id);
    else { this.queue.mark(plan.source.path, result.status === 'review' ? 'review' : 'failed', result.message); throw new OrganizerError('stale', result.message); }
  }
  async undoMove(id: string): Promise<void> {
    const result = await this.moves.undo(id);
    if (result.status !== 'done') throw new OrganizerError('stale', result.message);
    this.queue.mark(result.record.from, 'waiting', '已移回收件箱，需要时可重新分析。'); this.events.emit();
  }
  recentMoves() { return this.store.journal.records(); }
  async findLinks(): Promise<void> {
    const session = this.editors.active(this.activePath);
    if (!session) throw new OrganizerError('missing', '请先在编辑器中打开一篇笔记。');
    session.clearSuppressions(); await this.analyzeLinks(session.id, false);
  }
  private async analyzeLinks(id: string, automatic: boolean): Promise<void> {
    const session = this.editors.get(id), snapshot = session?.snapshot();
    if (!session || !snapshot || !this.vault.linkSource(snapshot.path) || !this.ready) return;
    const settingsRevision = this.revision, epoch = this.index.epoch;
    const matcher = new LocalMentionMatcher(this.index);
    const inputs = matcher.inputs(snapshot, target => this.vault.allowed(target.path)).filter(input => !session.suppressed(input.anchor));
    if (!inputs.length) { if (!automatic) { this.message = '暂未找到合适的链接。'; this.links = []; this.events.emit(); } return; }
    const isCurrent = () => !this.disposed && this.revision === settingsRevision && this.index.epoch === epoch && session.snapshot()?.revision === snapshot.revision && this.vault.linkSource(snapshot.path) && inputs.every(input => input.candidates.every(target => this.index.get(target.noteId)?.revision === target.revision));
    try {
      const proposals = await this.recommender.propose(inputs, this.context(), { key: 'link:' + id, priority: automatic ? 'link' : 'manual', automatic, isCurrent });
      if (!isCurrent()) return;
      this.links = proposals.filter(proposal => proposal.selected !== null); this.message = automatic ? null : this.links.length ? null : '暂未找到合适的链接。'; this.events.emit();
    } catch (error) { if (!automatic) { this.report(error); throw error; } }
  }
  prepareLink(proposal: LinkProposal, target: number): LinkPlan { return this.linker.prepare(proposal, target); }
  confirmLink(plan: LinkPlan): void { this.editors.get(plan.anchor.editorSessionId)?.rememberInsertion(plan.anchor, plan.replacement, plan.target.noteId); this.linker.confirm(plan.id); this.links = this.links.filter(item => item.id !== plan.proposalId); this.events.emit(); }
  dismissLink(proposal: LinkProposal): void { this.editors.get(proposal.input.anchor.editorSessionId)?.suppress(proposal.input.anchor, proposal.selected); this.links = this.links.filter(item => item.id !== proposal.id); this.events.emit(); }
  openNote(path: string): void { void this.plugin.app.workspace.openLinkText(path, this.activePath ?? '', false); }
  target(id: number) { return this.index.get(id); }
  async testConnection(): Promise<void> { await this.scheduler.evaluate({ modelId: this.settings().modelId, state: 'A short example about learning.', questions: [{ id: 'connection', instructions: 'Choose the matching subject.', options: [{ id: 'learning', description: 'Learning and reading' }, { id: 'none', description: 'Other' }] }] }, { key: 'connection', priority: 'manual', automatic: false, isCurrent: () => !this.disposed }); }
  private report(error: unknown): void { this.message = messageFor(error); this.events.emit(); }
  dispose(): void { this.disposed = true; this.generation++; this.scheduler?.dispose(); this.queue?.dispose(); this.editors.dispose(); this.index.clear(); this.events.clear(); void this.store.flush().catch(() => undefined); }
}
