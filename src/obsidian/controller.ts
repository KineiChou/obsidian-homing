import { Plugin, TFile, TFolder, requestUrl, parseLinktext } from 'obsidian';
import { Emitter } from '../core/events';
import { messageFor, OrganizerError } from '../core/errors';
import { contentHash, safePath, within } from '../core/paths';
import { DEFAULT_SETTINGS, parseSettings, type OrganizerSettings } from '../settings';
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
import type { LinkConfirmation, LinkPlan, LinkProposal } from '../linking/types';
import type { FilingEntry, FilingProposal, PersistedFilingProposal, MovePlan } from '../filing/types';
import { EditorSessions } from './editor-extension';
import { VaultAdapter } from './vault-adapter';
import { filingSettingsKey, linkSettingsKey } from './settings-impact';

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
  private filing: readonly FilingEntry[] = [];
  private configuration: OrganizerSettings = structuredClone(DEFAULT_SETTINGS);
  private settingsWrite: Promise<void> = Promise.resolve();
  private filingRevision = 0;
  private linkRevision = 0;
  private filingFingerprint = '';
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
      changed: (session, path, change) => {
        this.scheduler?.cancel('link:' + session); this.scheduler?.cancel('filing:' + path);
        const file = this.vault.file(path); if (file) this.vault.touch(file);
        this.links = this.links.flatMap(link => {
          if (link.input.anchor.editorSessionId !== session) return [link];
          const anchor = change?.mapAnchor(link.input.anchor);
          return anchor ? [{ ...link, input: { ...link.input, anchor } }] : [];
        });
        if (this.queue?.entries().some(entry => entry.path === path && entry.proposal)) this.queue.mark(path, 'waiting', '内容已改变，等待保存后重新分析。');
        this.message = null; this.events.emit();
      },
      idle: session => { if (this.enabled() && this.settings().autoLinks) void this.analyzeLinks(session, true); },
    });
  }
  async initialize(): Promise<void> {
    await this.store.load();
    this.configuration = this.store.snapshot().settings;
    this.filingFingerprint = await contentHash(filingSettingsKey(this.configuration));
    const client = new JevClient({ post: async (url, headers, body) => {
      try { const response = await requestUrl({ url, method: 'POST', headers: { ...headers }, body, throw: false }); let json: unknown = null; try { json = response.json; } catch { /* HTTP status remains authoritative for non-JSON failures. */ } return { status: response.status, headers: response.headers, json }; }
      catch { throw new OrganizerError('network', '暂时无法连接 Jev，请稍后重试。'); }
    } }, { get: () => this.plugin.app.secretStorage.getSecret(this.settings().secretName) });
    this.scheduler = new SharedDecisionScheduler(client, this.store.usage, () => this.settings().dailyRequestLimit);
    const classifier = new MixedDepthClassifier(this.scheduler);
    this.queue = new StableInboxQueue({
      eligible: path => this.vault.eligible(path), automaticEnabled: () => this.enabled() && this.settings().autoFiling,
      encodeProposal: proposal => this.encodeProposal(proposal), restoreProposal: (path, proposal) => this.restoreProposal(path, proposal),
      isEditing: path => this.editors.editing(path), persist: entries => this.store.updateQueue(entries),
      propose: async (path, automatic, isCurrent) => {
        const note = await this.vault.note(path, !automatic), folders = this.catalog.snapshot(), settings = this.filingRevision;
        return classifier.propose(note, folders, this.context(), { key: 'filing:' + path, priority: automatic ? 'filing' : 'manual', automatic, isCurrent: () => !this.disposed && isCurrent() && this.filingRevision === settings && this.vault.revision(path) === note.source.revision && this.catalog.snapshot().revision === folders.revision && this.vault.eligible(path) });
      },
    });
    this.moves = new ConfirmedMoveService({ source: path => this.vault.source(path), currentPath: id => this.vault.currentPath(id), exists: path => Boolean(this.plugin.app.vault.getAbstractFileByPath(path)), eligible: path => this.vault.eligible(path), referencesSafe: (path, destination) => this.vault.referencesSafe(path, destination), rename: (from, to) => this.vault.rename(from, to), folders: () => this.catalog.snapshot(), settingsRevision: () => this.filingRevision }, this.store.journal);
    this.recommender = new JevLinkRecommender(this.scheduler);
    const app = this.plugin.app;
    this.linker = new ConfirmedLinkService(this.index, {
      editor: id => this.editors.get(id)?.forConfirmation(), settingsRevision: () => this.linkRevision,
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
    await this.queue.restore(this.store.snapshot().filingQueue);
    await this.queue.restore(this.plugin.app.vault.getMarkdownFiles().filter(file => this.vault.eligible(file.path)).map(file => ({ path: file.path, status: 'pending' as const })));
    this.filing = this.queue.entries();
    await this.moves.recover();
    this.plugin.register(this.queue.subscribe(() => { this.filing = this.queue.entries(); this.events.emit(); }));
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
        if (within(this.settings().inbox, oldPath)) void this.saveSettings({ inbox: file.path + this.settings().inbox.slice(oldPath.length) }).catch(error => this.report(error));
        this.refreshFolders();
      } else if (file instanceof TFile) { this.vault.touch(file); this.vault.metadata(file); this.queue.rename(oldPath, file.path); if (this.vault.eligible(file.path)) this.queue.touch(file.path, true); }
      this.invalidateLinks();
    }));
    this.plugin.registerEvent(vault.on('delete', file => {
      if (file instanceof TFile) { this.vault.remove(file); this.queue.remove(file.path); }
      else { this.vault.removeUnder(file.path); for (const entry of this.queue.entries()) if (within(entry.path, file.path)) this.queue.remove(entry.path); this.refreshFolders(); }
      this.invalidateLinks();
    }));
    this.plugin.registerEvent(workspace.on('file-open', file => { if (!file) return; this.activePath = file.path; this.events.emit(); }));
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
  private refreshFolders(): void {
    const revision = this.catalog.snapshot().revision;
    this.catalog.refresh(this.vault.allFolders(), this.settings());
    if (this.catalog.snapshot().revision !== revision) this.queue?.invalidate(proposal => this.preserveProposal(proposal));
    this.events.emit();
  }
  private preserveProposal(proposal: FilingProposal): FilingProposal | null {
    const folders = this.catalog.snapshot();
    if (proposal.selected === null || !folders.targets.some(target => target.id === proposal.selected) || proposal.context.settingsRevision !== this.filingRevision) return null;
    return { ...proposal, foldersRevision: folders.revision, ranked: proposal.ranked.filter(item => folders.targets.some(target => target.id === item.targetId)) };
  }
  private encodeProposal(proposal: FilingProposal): PersistedFilingProposal | undefined {
    const folders = this.catalog.snapshot().targets;
    const selectedPath = proposal.selected === null ? null : folders.find(target => target.id === proposal.selected)?.path;
    if (selectedPath === undefined || proposal.context.settingsRevision !== this.filingRevision) return undefined;
    return { contentHash: proposal.source.contentHash, selectedPath, ranked: proposal.ranked.flatMap(item => { const target = folders.find(target => target.id === item.targetId); return target ? [{ path: target.path, probability: item.probability }] : []; }).slice(0, 3), modelId: proposal.context.modelId, promptRevision: proposal.context.promptRevision, settingsFingerprint: this.filingFingerprint, createdAt: Date.now(), ...(proposal.excerpt ? { excerpt: proposal.excerpt } : {}) };
  }
  private async restoreProposal(path: string, saved: PersistedFilingProposal): Promise<FilingProposal | null> {
    const fingerprint = this.filingFingerprint, revision = this.filingRevision;
    if (saved.modelId !== this.settings().modelId || saved.promptRevision !== 1 || saved.settingsFingerprint !== fingerprint) return null;
    const source = await this.vault.source(path), folders = this.catalog.snapshot();
    if (!source || source.contentHash !== saved.contentHash || fingerprint !== this.filingFingerprint || revision !== this.filingRevision) return null;
    const target = saved.selectedPath === null ? null : folders.targets.find(target => target.path === saved.selectedPath);
    if (target === undefined) return null;
    return { id: crypto.randomUUID(), source, foldersRevision: folders.revision, context: this.context(), selected: target?.id ?? null, ranked: saved.ranked.flatMap(item => { const target = folders.targets.find(target => target.path === item.path); return target ? [{ targetId: target.id, probability: item.probability }] : []; }), ...(saved.excerpt ? { excerpt: saved.excerpt } : {}) };
  }
  private invalidateLinks(): void {
    const previous = this.links.length;
    this.links = this.links.filter(proposal => proposal.input.catalogueEpoch === this.index.epoch && proposal.input.candidates.every(target => this.index.get(target.noteId)?.revision === target.revision));
    if (previous !== this.links.length) this.events.emit();
  }
  private context(kind: 'filing' | 'link' = 'filing') { return { taskId: crypto.randomUUID(), settingsRevision: kind === 'filing' ? this.filingRevision : this.linkRevision, promptRevision: 1, modelId: this.settings().modelId }; }
  state(): ReviewState { return { filing: this.filing, links: this.links.filter(link => link.input.anchor.sourcePath === this.activePath), activePath: this.activePath, network: this.scheduler.status(), indexReady: this.ready, message: this.message }; }
  subscribe(listener: () => void) { return this.events.subscribe(listener); }
  settings(): OrganizerSettings { return this.configuration; }
  enabled(): boolean { return this.store.automaticEnabled(); }
  setEnabled(enabled: boolean): void { this.store.setAutomaticEnabled(enabled); if (!enabled) this.queue.invalidate(proposal => this.preserveProposal(proposal)); this.events.emit(); }
  saveSettings(patch: Partial<OrganizerSettings>): Promise<void> {
    const update = this.settingsWrite.then(async () => {
      const settings = parseSettings({ ...this.settings(), ...patch });
      const before = this.settings();
      const filingChanged = filingSettingsKey(before) !== filingSettingsKey(settings), linksChanged = linkSettingsKey(before) !== linkSettingsKey(settings);
      const fingerprint = filingChanged ? await contentHash(filingSettingsKey(settings)) : this.filingFingerprint;
      await this.store.updateSettings(settings); this.configuration = this.store.snapshot().settings; this.filingFingerprint = fingerprint;
      if (filingChanged) this.filingRevision++;
      if (linksChanged) { this.linkRevision++; this.links = []; }
      if (before.secretName !== settings.secretName || before.modelId !== settings.modelId) this.scheduler.setPaused(false);
      const folderRevision = this.catalog.snapshot().revision; this.refreshFolders();
      if (filingChanged && folderRevision === this.catalog.snapshot().revision) this.queue.invalidate(proposal => this.preserveProposal(proposal));
      if (JSON.stringify(before.excludedPaths) !== JSON.stringify(settings.excludedPaths)) { this.index.clear(); void this.buildIndex(); }
      this.events.emit();
    });
    this.settingsWrite = update.catch(() => undefined);
    return update;
  }
  usage() { return this.store.usage.read(); }
  folders() { return this.catalog.snapshot().targets; }
  allFolders() { return this.vault.allFolders(); }
  async createInbox(path: string): Promise<void> { const validated = parseSettings({ ...this.settings(), inbox: path }); if (!this.plugin.app.vault.getAbstractFileByPath(validated.inbox)) await this.plugin.app.vault.createFolder(validated.inbox); await this.saveSettings({ inbox: validated.inbox }); }
  previewAnalysis(paths?: readonly string[]) {
    const entries = new Map(this.queue.entries().map(entry => [entry.path, entry]));
    const selected = paths ? new Set(paths) : null;
    const notes = this.plugin.app.vault.getMarkdownFiles().filter(file => this.vault.eligible(file.path) && (!selected || selected.has(file.path)) && !['ignored', 'ready', 'analyzing', 'moving'].includes(entries.get(file.path)?.status ?? '')).sort((a, b) => b.stat.mtime - a.stat.mtime || a.path.localeCompare(b.path)).map(file => ({ path: file.path, modifiedAt: file.stat.mtime }));
    const targets = this.catalog.snapshot().targets.length;
    const min = targets > 254 ? Math.ceil(targets / 64) + 1 : targets ? 1 : 0;
    const max = min * 3;
    const remainingRequests = Math.max(0, this.settings().dailyRequestLimit - this.usage().requests);
    return { notes, remainingRequests, requestsPerNote: { min, max }, recommendedCount: Math.min(notes.length, max ? Math.floor(remainingRequests / max) : notes.length) };
  }
  analyzeInbox(paths: readonly string[] = []): void { for (const note of this.previewAnalysis(paths).notes) this.queue.analyze(note.path); }
  async readPreview(path: string): Promise<{ text: string; truncated: boolean }> {
    safePath(path);
    const file = this.vault.file(path);
    if (!file || (!this.vault.eligible(path) && !this.store.journal.records().some(record => record.to === path))) throw new OrganizerError('missing', '笔记已不存在。');
    const text = await this.plugin.app.vault.cachedRead(file);
    let end = Math.min(text.length, 20000);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
    return { text: text.slice(0, end), truncated: end < text.length };
  }
  async createDestination(path: string) {
    const validated = safePath(path), probe = new MemoryFolderCatalog();
    probe.refresh([validated], this.settings());
    if (!probe.snapshot().targets.length) throw new OrganizerError('invalid-settings', '此目录不能作为归档位置。');
    const existing = this.plugin.app.vault.getAbstractFileByPath(validated);
    if (existing && !(existing instanceof TFolder)) throw new OrganizerError('conflict', '该路径已被文件占用。');
    if (!existing) await this.plugin.app.vault.createFolder(validated);
    this.refreshFolders();
    const target = this.catalog.snapshot().targets.find(target => target.path === validated);
    if (!target) throw new OrganizerError('stale', '目录设置已变化，请重新选择。');
    return target;
  }
  analyzeNote(path: string): void { this.queue.analyze(path); }
  ignoreNote(path: string): void { this.scheduler.cancel('filing:' + path); this.queue.ignore(path); }
  restoreIgnored(): void { for (const entry of this.queue.entries()) if (entry.status === 'ignored') this.queue.resume(entry.path); }
  async prepareMove(path: string, target: string): Promise<MovePlan> {
    const entry = this.filing.find(item => item.path === path), proposal = entry?.proposal;
    const plan = await this.moves.prepare(path, target);
    if (proposal && (proposal.source.contentHash !== plan.source.contentHash || proposal.source.revision !== plan.source.revision || proposal.foldersRevision !== plan.foldersRevision || proposal.context.settingsRevision !== this.filingRevision)) throw new OrganizerError('stale', '建议已过期，请重新分析。');
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
  async acknowledgeMove(id: string): Promise<void> { await this.moves.acknowledge(id); this.events.emit(); }
  recentMoves() { return this.store.journal.records(); }
  async findLinks(): Promise<void> {
    const session = this.editors.active(this.activePath);
    if (!session) throw new OrganizerError('missing', '请先在编辑器中打开一篇笔记。');
    session.clearSuppressions(); await this.analyzeLinks(session.id, false);
  }
  private async analyzeLinks(id: string, automatic: boolean): Promise<void> {
    const session = this.editors.get(id), snapshot = session?.snapshot({ dirtyOnly: automatic });
    if (!session || !snapshot || !this.vault.linkSource(snapshot.path) || !this.ready) return;
    const settingsRevision = this.linkRevision, epoch = this.index.epoch;
    const matcher = new LocalMentionMatcher(this.index);
    const inputs = matcher.inputs(snapshot, target => this.vault.allowed(target.path)).filter(input => !session.suppressed(input.anchor));
    if (!inputs.length) { if (!automatic) { this.message = '暂未找到合适的链接。'; this.events.emit(); } return; }
    const isCurrent = () => !this.disposed && (!automatic || (this.enabled() && this.settings().autoLinks)) && this.linkRevision === settingsRevision && this.index.epoch === epoch && session.currentRevision === snapshot.revision && session.path === snapshot.path && this.vault.linkSource(snapshot.path) && inputs.every(input => input.candidates.every(target => this.index.get(target.noteId)?.revision === target.revision));
    try {
      const proposals = await this.recommender.propose(inputs, this.context('link'), { key: 'link:' + id, priority: automatic ? 'link' : 'manual', automatic, isCurrent });
      if (!isCurrent()) return;
      this.links = [...this.links.filter(existing => !inputs.some(input => input.anchor.editorSessionId === existing.input.anchor.editorSessionId && input.anchor.from === existing.input.anchor.from && input.anchor.to === existing.input.anchor.to)), ...proposals.filter(proposal => proposal.selected !== null)]; this.message = automatic ? null : this.links.length ? null : '暂未找到合适的链接。'; this.events.emit();
    } catch (error) { if (!automatic) { this.report(error); throw error; } }
  }
  prepareLink(proposal: LinkProposal, target: number): LinkPlan { return this.linker.prepare(proposal, target); }
  confirmLinks(plans: readonly LinkPlan[]): LinkConfirmation {
    const result = this.linker.confirmMany(plans.map(plan => plan.id));
    const applied = new Set(plans.filter(plan => result.appliedPlanIds.includes(plan.id)).map(plan => plan.proposalId));
    this.links = this.links.filter(item => !applied.has(item.id)); this.events.emit(); return result;
  }
  confirmLink(plan: LinkPlan): void { const result = this.confirmLinks([plan]); if (result.failures[0]) throw result.failures[0].error; }
  dismissLink(proposal: LinkProposal): void { this.editors.get(proposal.input.anchor.editorSessionId)?.suppress(proposal.input.anchor, proposal.selected); this.links = this.links.filter(item => item.id !== proposal.id); this.events.emit(); }
  openNote(path: string): void { void this.plugin.app.workspace.openLinkText(path, this.activePath ?? '', false); }
  target(id: number) { return this.index.get(id); }
  async testConnection(): Promise<void> { this.scheduler.setPaused(false); await this.scheduler.evaluate({ modelId: this.settings().modelId, state: 'A short example about learning.', questions: [{ id: 'connection', instructions: 'Choose the matching subject.', options: [{ id: 'learning', description: 'Learning and reading' }, { id: 'none', description: 'Other' }] }] }, { key: 'connection', priority: 'manual', automatic: false, isCurrent: () => !this.disposed }); }
  private report(error: unknown): void { this.message = messageFor(error); this.events.emit(); }
  dispose(): void { this.disposed = true; this.generation++; this.scheduler?.dispose(); this.queue?.dispose(); this.editors.dispose(); this.index.clear(); this.events.clear(); void this.store.flush().catch(() => undefined); }
}
