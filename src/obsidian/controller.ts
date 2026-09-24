import { Plugin, TFile, TFolder, requestUrl, parseLinktext, prepareFuzzySearch } from 'obsidian';
import { Emitter } from '../core/events';
import { messageFor, OrganizerError } from '../core/errors';
import { contentHash, safePath, within } from '../core/paths';
import { DEFAULT_SETTINGS, parseSettings, type OrganizerSettings } from '../settings';
import { MemoryFolderCatalog } from '../folders/catalog';
import { PluginStateStore } from '../storage/state-store';
import { StableInboxQueue } from '../filing/inbox-queue';
import { ConfirmedMoveService } from '../filing/move-service';
import { MixedDepthClassifier } from '../filing/classifier';
import { createDecisionClient } from '../providers/client';
import { prepareNote } from '../filing/note-excerpt';
import { MemoryFolderProfiles } from '../folders/profiles';
import { SharedDecisionScheduler } from '../jev/scheduler';
import { MemoryMetadataIndex } from '../linking/metadata-index';
import { LocalMentionMatcher, sentenceRange } from '../linking/mention-matcher';
import { MemoryLinkGraph } from '../linking/link-graph';
import { searchTargets } from '../linking/target-search';
import { normalize } from '../linking/terms';
import { JevLinkRecommender } from '../linking/recommender';
import { ConfirmedLinkService } from '../linking/link-service';
import type { LinkMention, OrganizerController, ReviewState } from '../ui/types';
import type { LinkConfirmation, LinkInput, LinkPlan, LinkProposal, LinkTarget, LocalMention, TextRange } from '../linking/types';
import type { FilingEntry, FilingProposal, PersistedFilingProposal, MovePlan } from '../filing/types';
import { EditorSessions } from './editor-extension';
import { VaultAdapter } from './vault-adapter';
import { claimLifecycle, type LifecycleLease } from './lifecycle';
import { estimateFilingRequests } from './analysis-estimate';
import { filingSettingsKey, linkSettingsKey } from './settings-impact';

export class ObsidianOrganizer implements OrganizerController {
  readonly events = new Emitter();
  readonly store: PluginStateStore;
  readonly index = new MemoryMetadataIndex();
  readonly graph = new MemoryLinkGraph();
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
  private requestRevision = 0;
  private readonly profiles = new MemoryFolderProfiles();
  private readonly excerpts = new Map<string, { originalChars: number; sentChars: number }>();
  private filingFingerprint = '';
  private generation = 0;
  private ready = false;
  private disposed = false;
  private initialization: Promise<void> | undefined;
  private shutdown: Promise<void> | undefined;
  private lifecycle: LifecycleLease | undefined;
  private readonly operations = new Set<Promise<unknown>>();
  private message: string | null = null;
  private activePath: string | null = null;
  constructor(private readonly plugin: Plugin) {
    this.store = new PluginStateStore({ load: () => plugin.loadData(), save: data => plugin.saveData(data), loadLocal: key => plugin.app.loadLocalStorage(key), saveLocal: (key, value) => plugin.app.saveLocalStorage(key, value) });
    this.vault = new VaultAdapter(plugin.app, this.index, () => this.settings(), this.graph);
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
        this.excerpts.delete(path);
        if (this.queue?.entries().some(entry => entry.path === path && (entry.proposal !== undefined || entry.status === 'analyzing') && !['ignored', 'done', 'moving', 'review'].includes(entry.status))) this.queue.mark(path, 'waiting', 'host.contentChanged');
        this.message = null; this.events.emit();
      },
      idle: session => { if (this.enabled() && this.settings().autoLinks) void this.preverify(session); },
    });
  }
  initialize(): Promise<void> {
    if (this.disposed) return Promise.reject(new OrganizerError('cancelled', 'error.analysisStopped'));
    this.initialization ??= this.initializeState().catch(error => { void this.dispose(); throw error; });
    return this.initialization;
  }
  private async initializeState(): Promise<void> {
    this.lifecycle = claimLifecycle(this.plugin.app);
    await this.lifecycle.previous;
    this.assertActive();
    await this.store.load();
    this.assertActive();
    this.configuration = this.store.snapshot().settings;
    this.filingFingerprint = await contentHash(filingSettingsKey(this.configuration));
    this.assertActive();
    const client = createDecisionClient({ post: async (url, headers, body) => {
      try { const response = await requestUrl({ url, method: 'POST', headers: { ...headers }, body, throw: false }); let json: unknown = null; try { json = response.json; } catch { /* HTTP status remains authoritative for non-JSON failures. */ } return { status: response.status, headers: response.headers, json }; }
      catch { throw new OrganizerError('network', 'error.network'); }
    } }, { get: () => this.plugin.app.secretStorage.getSecret(this.settings().secretName) }, () => this.settings());
    this.scheduler = new SharedDecisionScheduler(client, this.store.usage, () => this.settings().dailyRequestLimit);
    const classifier = new MixedDepthClassifier(this.scheduler, () => ({ longNoteStrategy: this.settings().longNoteStrategy, ...(this.settings().folderProfilesEnabled ? { profiles: this.profiles } : {}) }));
    this.refreshFolders();
    this.queue = new StableInboxQueue({
      eligible: path => this.vault.eligible(path), automaticEnabled: () => this.enabled() && this.settings().autoFiling,
      encodeProposal: proposal => this.encodeProposal(proposal), restoreProposal: (path, proposal) => this.restoreProposal(path, proposal),
      isEditing: path => this.editors.editing(path), persist: entries => this.store.updateQueue(entries),
      propose: async (path, automatic, isCurrent) => {
        const note = await this.vault.note(path, !automatic), folders = this.catalog.snapshot(), settings = this.filingRevision, requestRevision = this.requestRevision;
        const prepared = prepareNote(note, this.settings().longNoteStrategy);
        if (prepared.excerpt) this.excerpts.set(path, prepared.excerpt); else this.excerpts.delete(path);
        this.events.emit();
        return classifier.propose(prepared.note, folders, this.context(), { key: 'filing:' + path, priority: automatic ? 'filing' : 'manual', automatic, isCurrent: () => !this.disposed && this.requestRevision === requestRevision && isCurrent() && this.filingRevision === settings && this.vault.revision(path) === note.source.revision && this.catalog.snapshot().revision === folders.revision && this.vault.eligible(path) });
      },
    });
    this.moves = new ConfirmedMoveService({ source: path => this.vault.source(path), currentPath: id => this.vault.currentPath(id), exists: path => Boolean(this.plugin.app.vault.getAbstractFileByPath(path)), eligible: path => this.vault.eligible(path), referencesSafe: (path, destination) => this.vault.referencesSafe(path, destination), rename: (from, to) => this.vault.rename(from, to), folders: () => this.catalog.snapshot(), settingsRevision: () => this.filingRevision }, this.store.journal);
    this.recommender = new JevLinkRecommender(this.scheduler);
    const app = this.plugin.app;
    this.linker = new ConfirmedLinkService(this.index, {
      editor: id => this.editors.get(id)?.forConfirmation(), settingsRevision: () => this.linkRevision,
      allowed: target => this.vault.allowed(target.path),
      generateLink: (target, source, alias) => { const file = this.vault.file(target.path); if (!file) throw new OrganizerError('missing', 'error.linkTargetChanged'); return app.fileManager.generateMarkdownLink(file, source, undefined, alias); },
      resolvesTo: (link, source, target) => {
        const match = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(link) ?? /^\[[^\]]*\]\(([^)]+)\)$/.exec(link.trim());
        if (!match?.[1]) return false;
        let path = match[1]; try { path = decodeURI(path); } catch { return false; }
        return app.metadataCache.getFirstLinkpathDest(parseLinktext(path).path, source)?.path === target.path;
      },
    });
    await this.queue.restore(this.store.snapshot().filingQueue);
    this.assertActive();
    await this.queue.restore(this.plugin.app.vault.getMarkdownFiles().filter(file => this.vault.eligible(file.path)).map(file => ({ path: file.path, status: 'pending' as const })));
    this.assertActive();
    this.filing = this.queue.entries();
    await this.moves.recover();
    this.assertActive();
    this.plugin.register(this.queue.subscribe(() => { this.filing = this.queue.entries(); this.events.emit(); }));
    this.plugin.register(this.scheduler.subscribe(() => this.events.emit()));
    this.plugin.registerEditorExtension(this.editors.extension);
    this.plugin.app.workspace.onLayoutReady(() => { if (!this.disposed) this.start(); });
  }
  private start(): void {
    const { vault, metadataCache, workspace } = this.plugin.app;
    this.plugin.registerEvent(vault.on('create', file => { if (file instanceof TFolder) this.refreshFolders(); else if (file instanceof TFile) { this.metadata(file); if (this.vault.eligible(file.path)) this.queue.touch(file.path, true); } }));
    this.plugin.registerEvent(vault.on('modify', file => { if (file instanceof TFile) { this.vault.touch(file); this.metadata(file); this.invalidateLinks(); if (this.vault.eligible(file.path)) this.queue.touch(file.path, true); } }));
    this.plugin.registerEvent(metadataCache.on('changed', file => { this.metadata(file); this.invalidateLinks(); }));
    this.plugin.registerEvent(vault.on('rename', (file, oldPath) => {
      if (file instanceof TFolder) {
        this.removeProfilesUnder(oldPath);
        for (const entry of this.queue.entries()) if (within(entry.path, oldPath)) this.queue.rename(entry.path, file.path + entry.path.slice(oldPath.length));
        for (const note of vault.getMarkdownFiles()) if (within(note.path, file.path)) { this.vault.touch(note); this.metadata(note); }
        if (within(this.settings().inbox, oldPath)) void this.saveSettings({ inbox: file.path + this.settings().inbox.slice(oldPath.length) }).catch(error => this.report(error));
        this.refreshFolders();
      } else if (file instanceof TFile) { this.profiles.remove(oldPath); this.profilePaths.delete(oldPath); this.excerpts.delete(oldPath); this.vault.touch(file); this.metadata(file); this.queue.rename(oldPath, file.path); if (this.vault.eligible(file.path)) this.queue.touch(file.path, true); }
      this.invalidateLinks();
    }));
    this.plugin.registerEvent(vault.on('delete', file => {
      if (file instanceof TFile) { this.profiles.remove(file.path); this.profilePaths.delete(file.path); this.excerpts.delete(file.path); this.vault.remove(file); this.queue.remove(file.path); }
      else { this.removeProfilesUnder(file.path); this.vault.removeUnder(file.path); for (const entry of this.queue.entries()) if (within(entry.path, file.path)) this.queue.remove(entry.path); this.refreshFolders(); }
      this.invalidateLinks();
    }));
    this.plugin.registerEvent(workspace.on('file-open', file => { if (!file) return; this.activePath = file.path; this.analyzeOpened(file.path); this.events.emit(); }));
    this.activePath = workspace.getActiveFile()?.path ?? null;
    void this.buildIndex();
  }
  private readonly opened = new Set<string>();
  /** Opening an inbox note without a suggestion is an explicit request for that note only, once per content version. */
  private analyzeOpened(path: string): void {
    const settings = this.settings(), entry = this.queue.entries().find(item => item.path === path);
    if (!settings.analyzeOnOpen || !settings.autoFiling || !this.enabled() || !this.vault.eligible(path) || entry?.status !== 'waiting' || entry.proposal) return;
    const key = path + '\u0000' + this.vault.revision(path);
    if (this.opened.has(key)) return;
    this.opened.add(key); if (this.opened.size > 512) this.opened.delete(this.opened.values().next().value!);
    this.analyzeNote(path);
  }
  private readonly profilePaths = new Set<string>();
  private metadata(file: TFile): void {
    this.vault.metadata(file);
    const id = this.vault.id(file.path), target = id === null ? undefined : this.index.get(id);
    if (target) { this.profiles.upsert({ path: target.path, title: target.title, tags: target.tags }); this.profilePaths.add(target.path); }
    else { this.profiles.remove(file.path); this.profilePaths.delete(file.path); }
  }
  private removeProfilesUnder(path: string): void { for (const item of this.profilePaths) if (within(item, path)) { this.profiles.remove(item); this.profilePaths.delete(item); } }
  private async buildIndex(): Promise<void> {
    const generation = ++this.generation;
    this.ready = false;
    const files = this.plugin.app.vault.getMarkdownFiles();
    let cursor = 0;
    while (cursor < files.length && !this.disposed && generation === this.generation) {
      const started = performance.now(); let count = 0;
      while (cursor < files.length && count++ < 250 && performance.now() - started < 4) {
        const file = files[cursor++];
        if (file && this.vault.file(file.path) === file) this.metadata(file);
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
  state(): ReviewState { return { filing: this.filing.map(entry => ({ ...entry, ...(this.excerpts.has(entry.path) ? { excerpt: this.excerpts.get(entry.path)! } : {}) })), links: this.links.filter(link => link.input.anchor.sourcePath === this.activePath), activePath: this.activePath, network: this.scheduler.status(), indexReady: this.ready, message: this.message }; }
  subscribe(listener: () => void) { return this.events.subscribe(listener); }
  settings(): OrganizerSettings { return this.configuration; }
  enabled(): boolean { return this.store.automaticEnabled(); }
  setEnabled(enabled: boolean): void { this.assertActive(); this.store.setAutomaticEnabled(enabled); if (!enabled) this.queue.invalidate(proposal => this.preserveProposal(proposal)); this.events.emit(); }
  saveSettings(patch: Partial<OrganizerSettings>): Promise<void> {
    if (this.disposed) return Promise.reject(new OrganizerError('cancelled', 'error.analysisStopped'));
    const update = this.settingsWrite.then(async () => {
      const settings = parseSettings({ ...this.settings(), ...patch });
      const before = this.settings();
      const filingChanged = filingSettingsKey(before) !== filingSettingsKey(settings), linksChanged = linkSettingsKey(before) !== linkSettingsKey(settings);
      const fingerprint = filingChanged ? await contentHash(filingSettingsKey(settings)) : this.filingFingerprint;
      await this.store.updateSettings(settings); this.configuration = this.store.snapshot().settings; this.filingFingerprint = fingerprint;
      if (this.disposed) return;
      if (filingChanged) { this.filingRevision++; this.excerpts.clear(); }
      if (linksChanged) { this.linkRevision++; this.links = []; }
      if (before.secretName !== settings.secretName || before.modelId !== settings.modelId || before.provider !== settings.provider || before.endpoint !== settings.endpoint) {
        this.requestRevision++;
        // Cancel pending work without invalidating already reviewed proposals on a credential change.
        this.scheduler.setPaused(true); this.scheduler.setPaused(false);
      }
      const folderRevision = this.catalog.snapshot().revision; this.refreshFolders();
      if ((filingChanged || (before.autoFiling && !settings.autoFiling)) && folderRevision === this.catalog.snapshot().revision) this.queue.invalidate(proposal => this.preserveProposal(proposal));
      if (JSON.stringify(before.excludedPaths) !== JSON.stringify(settings.excludedPaths)) { this.index.clear(); this.graph.clear(); this.verdicts.clear(); this.profiles.clear(); this.profilePaths.clear(); void this.buildIndex(); }
      this.events.emit();
    });
    this.settingsWrite = update.catch(() => undefined);
    return update;
  }
  usage() { return this.store.usage.read(); }
  folders() { return this.catalog.snapshot().targets; }
  allFolders() { return this.vault.allFolders(); }
  createInbox(path: string): Promise<void> { return this.track(async () => { const validated = parseSettings({ ...this.settings(), inbox: path }); if (!this.plugin.app.vault.getAbstractFileByPath(validated.inbox)) await this.plugin.app.vault.createFolder(validated.inbox); await this.saveSettings({ inbox: validated.inbox }); }); }
  previewAnalysis(paths?: readonly string[]) {
    const entries = new Map(this.queue.entries().map(entry => [entry.path, entry]));
    const selected = paths ? new Set(paths) : null;
    const notes = this.plugin.app.vault.getMarkdownFiles().filter(file => this.vault.eligible(file.path) && (!selected || selected.has(file.path)) && !['ignored', 'analyzing', 'moving', ...(!selected ? ['ready'] : [])].includes(entries.get(file.path)?.status ?? '')).sort((a, b) => b.stat.mtime - a.stat.mtime || a.path.localeCompare(b.path)).map(file => ({ path: file.path, modifiedAt: file.stat.mtime }));
    const targets = this.settings().folderProfilesEnabled ? this.profiles.enrich(this.catalog.snapshot().targets) : this.catalog.snapshot().targets;
    const estimates = notes.map(note => estimateFilingRequests(targets, this.settings().longNoteStrategy === 'excerpt' ? Math.min(12000, this.vault.file(note.path)?.stat.size ?? 12000) : this.vault.file(note.path)?.stat.size ?? 30000));
    const min = estimates.length ? Math.min(...estimates.map(item => item.min)) : 0;
    const max = estimates.length ? Math.max(...estimates.map(item => item.max)) + (this.settings().folderProfilesEnabled && targets.length > 254 ? 1 : 0) : 0;
    const remainingRequests = Math.max(0, this.settings().dailyRequestLimit - this.usage().requests);
    return { notes, remainingRequests, requestsPerNote: { min, max }, recommendedCount: Math.min(notes.length, max ? Math.max(remainingRequests >= min ? 1 : 0, Math.floor(remainingRequests / max)) : 0) };
  }
  analyzeInbox(paths: readonly string[] = []): void { for (const note of this.previewAnalysis(paths).notes) this.queue.analyze(note.path); }
  async readPreview(path: string): Promise<{ text: string; truncated: boolean }> {
    safePath(path);
    const file = this.vault.file(path);
    if (!file || (!this.vault.eligible(path) && !this.store.journal.records().some(record => record.to === path))) throw new OrganizerError('missing', 'host.noteMissing');
    const vault = this.plugin.app.vault;
    const text = await (typeof vault.cachedRead === 'function' ? vault.cachedRead(file) : vault.read(file));
    let end = Math.min(text.length, 20000);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
    return { text: text.slice(0, end), truncated: end < text.length };
  }
  async createDestination(path: string) {
    return this.track(async () => {
      const validated = safePath(path), probe = new MemoryFolderCatalog();
      probe.refresh([validated], this.settings());
      if (!probe.snapshot().targets.length) throw new OrganizerError('invalid-settings', 'host.destinationExcluded');
      const existing = this.plugin.app.vault.getAbstractFileByPath(validated);
      if (existing && !(existing instanceof TFolder)) throw new OrganizerError('conflict', 'host.pathOccupied');
      if (!existing) await this.plugin.app.vault.createFolder(validated);
      this.refreshFolders();
      const target = this.catalog.snapshot().targets.find(target => target.path === validated);
      if (!target) throw new OrganizerError('stale', 'host.folderChanged');
      return target;
    });
  }
  analyzeNote(path: string): void { this.excerpts.delete(path); this.queue.analyze(path); }
  ignoreNote(path: string): void { this.scheduler.cancel('filing:' + path); this.queue.ignore(path); }
  restoreIgnored(): void { for (const entry of this.queue.entries()) if (entry.status === 'ignored') this.queue.resume(entry.path); }
  async prepareMove(path: string, target: string): Promise<MovePlan> {
    const entry = this.filing.find(item => item.path === path), proposal = entry?.proposal;
    const plan = await this.moves.prepare(path, target);
    if (proposal && (proposal.source.contentHash !== plan.source.contentHash || proposal.source.revision !== plan.source.revision || proposal.foldersRevision !== plan.foldersRevision || proposal.context.settingsRevision !== this.filingRevision)) throw new OrganizerError('stale', 'error.analysisStale');
    return plan;
  }
  async confirmMove(plan: MovePlan): Promise<void> {
    return this.track(async () => {
      this.queue.mark(plan.source.path, 'moving');
      const result = await this.moves.confirm(plan.id);
      if (result.status === 'done') this.queue.mark(plan.source.path, 'done', 'organizer.done', result.record.id);
      else { this.queue.mark(plan.source.path, result.status === 'review' ? 'review' : 'failed', result.message); throw new OrganizerError('stale', result.message); }
    });
  }
  async undoMove(id: string): Promise<void> {
    return this.track(async () => {
      const result = await this.moves.undo(id);
      if (result.status !== 'done') throw new OrganizerError('stale', result.message);
      this.queue.mark(result.record.from, 'waiting', 'host.returned'); this.events.emit();
    });
  }
  async acknowledgeMove(id: string): Promise<void> {
    return this.track(async () => {
      const record = this.store.journal.records().find(item => item.id === id);
      await this.moves.acknowledge(id);
      if (record?.status === 'review') {
        if (this.vault.file(record.from) && this.vault.eligible(record.from)) this.queue.mark(record.from, 'waiting');
        else this.queue.remove(record.from);
      }
      this.events.emit();
    });
  }
  recentMoves() { return this.store.journal.records(); }
  // Link suggestions: local scan, cached model verdicts and user-confirmed plans (docs/link-matching.md §5–8).
  private readonly verdicts = new Map<string, number | null>();
  private findGeneration = 0;
  private ignoredCache: { source: readonly string[]; terms: ReadonlySet<string> } | undefined;
  private ignoredTerms(): ReadonlySet<string> {
    const source = this.settings().ignoredLinkTerms;
    if (this.ignoredCache?.source !== source) this.ignoredCache = { source, terms: new Set(source.map(term => normalize(term.trim()))) };
    return this.ignoredCache.terms;
  }
  private scanRange(session: NonNullable<ReturnType<EditorSessions['get']>>, from: number, to: number, parse = false): LocalMention[] {
    const path = session.path, noteId = path ? this.vault.id(path) : null;
    if (!path || noteId === null) return [];
    // Include a complete code point on both sides so viewport edges are not word boundaries.
    const start = Math.max(0, from - 2), end = Math.min(session.length, to + 2);
    return new LocalMentionMatcher(this.index, this.graph).scan({ sourceNoteId: noteId, sourcePath: path, text: session.read(start, end), offset: start, allowedRanges: session.allowedRangesIn(start, end, parse),
      linkedNoteIds: this.vault.linkedTargets(path), ignoredTerms: this.ignoredTerms(), allowed: target => this.vault.allowed(target.path) }).filter(mention => mention.from >= from && mention.to <= to && !session.suppressedAt(mention.from, mention.to, mention.text));
  }
  private linkInput(session: NonNullable<ReturnType<EditorSessions['get']>>, mention: LocalMention): LinkInput | null {
    const path = session.path, noteId = path ? this.vault.id(path) : null, revision = session.currentRevision;
    if (!path || noteId === null || revision === null || !this.vault.linkSource(path) || !session.allows(mention.from, mention.to) || session.read(mention.from, mention.to) !== mention.text) return null;
    const start = Math.max(0, mention.from - 240), end = Math.min(session.length, mention.to + 240), text = session.read(start, end);
    const range = session.allowedRangesIn(start, end).find(item => item.from <= mention.from && item.to >= mention.to);
    if (!range) return null;
    const local = sentenceRange(text, mention.from - start, mention.to - start, range.from - start, range.to - start);
    return { catalogueEpoch: this.index.epoch, candidates: mention.candidates.map(candidate => candidate.target),
      anchor: { editorSessionId: session.id, noteId, sourcePath: path, documentRevision: revision, from: mention.from, to: mention.to, originalText: mention.text, contextFrom: start + local.from, contextText: text.slice(local.from, local.to) } };
  }
  private verdictKey(input: LinkInput): string {
    const anchor = input.anchor;
    return [anchor.sourcePath, normalize(anchor.originalText), anchor.contextText, anchor.from - anchor.contextFrom, input.candidates.map(target => target.noteId + '@' + target.revision).join(','), this.linkRevision, this.settings().modelId].join('\u0000');
  }
  private remember(key: string, selected: number | null): void {
    this.verdicts.delete(key); this.verdicts.set(key, selected);
    if (this.verdicts.size > 512) this.verdicts.delete(this.verdicts.keys().next().value!);
  }
  scanLinks(sessionId: string, ranges: readonly TextRange[]): readonly LinkMention[] {
    const session = this.editors.get(sessionId), path = session?.path;
    if (!session || !path || !this.ready || this.settings().linkHints === 'off' || !this.vault.linkSource(path)) return [];
    const result: LinkMention[] = [];
    let budget = 20000;
    for (const range of ranges) {
      const to = Math.min(range.to, range.from + budget);
      if (to <= range.from) break;
      budget -= to - range.from;
      for (const mention of this.scanRange(session, range.from, to)) {
        const input = this.linkInput(session, mention);
        if (!input) continue;
        const verdictKey = this.verdictKey(input), verdict = this.verdicts.get(verdictKey);
        const current = { ...mention, verdictKey };
        // A model "no link" verdict hides the mention for this sentence.
        if (verdict === null) continue;
        result.push(verdict === undefined ? current : { ...current, verified: verdict });
      }
    }
    return result;
  }
  private currentMentionInput(sessionId: string, mention: LinkMention): LinkInput {
    const session = this.editors.get(sessionId);
    const current = session && this.scanRange(session, mention.from, mention.to).find(item => item.from === mention.from && item.to === mention.to && item.text === mention.text);
    const input = session && current ? this.linkInput(session, current) : null;
    if (!input || this.verdictKey(input) !== mention.verdictKey) throw new OrganizerError('stale', 'error.linkStale');
    return input;
  }
  async verifyLink(sessionId: string, mention: LinkMention): Promise<number | null> {
    const input = this.currentMentionInput(sessionId, mention);
    if (!this.settings().verifyOnHover) throw new OrganizerError('stale', 'error.linkStale');
    const key = this.verdictKey(input);
    if (this.verdicts.has(key)) return this.verdicts.get(key)!;
    const current = this.linkScope(input);
    const [proposal] = await this.recommender.propose([input], this.context('link'), { key: 'verify:' + sessionId, priority: 'manual', automatic: false, linkAllowance: true, isCurrent: () => this.settings().verifyOnHover && current() });
    if (!this.settings().verifyOnHover || !current()) throw new OrganizerError('stale', 'error.linkStale');
    const selected = proposal?.selected ?? null;
    this.remember(key, selected); this.events.emit();
    return selected;
  }
  private linkScope(input: LinkInput, automatic = false): () => boolean {
    const requestRevision = this.requestRevision, linkRevision = this.linkRevision, epoch = this.index.epoch;
    return () => !this.disposed && this.requestRevision === requestRevision && this.linkRevision === linkRevision && this.index.epoch === epoch && (!automatic || (this.enabled() && this.settings().autoLinks)) &&
      this.vault.linkSource(input.anchor.sourcePath) && input.candidates.every(target => this.currentTarget(target)) &&
      (input.anchor.editorSessionId === 'query' || (this.editors.get(input.anchor.editorSessionId)?.currentRevision === input.anchor.documentRevision && this.editors.get(input.anchor.editorSessionId)?.path === input.anchor.sourcePath));
  }
  linkProposalFor(sessionId: string, mention: LinkMention, targetId?: number): LinkProposal {
    const input = this.currentMentionInput(sessionId, mention);
    return { id: crypto.randomUUID(), input, context: this.context('link'), selected: targetId ?? mention.verified ?? mention.candidates[0]?.target.noteId ?? null };
  }
  ignoreLinkTerm(term: string): Promise<void> {
    const value = term.trim();
    if (!value || this.ignoredTerms().has(normalize(value))) return Promise.resolve();
    return this.saveSettings({ ignoredLinkTerms: [...this.settings().ignoredLinkTerms, value] });
  }
  /** Background pre-check of uncertain mentions near recent edits (the optional automatic mode). */
  private async preverify(id: string): Promise<void> {
    const session = this.editors.get(id), snapshot = session?.snapshot({ dirtyOnly: true });
    if (!session || !snapshot?.dirtyRanges?.length || !this.ready || !this.vault.linkSource(snapshot.path)) return;
    const inputs = this.scanRange(session, snapshot.contextFrom, snapshot.contextFrom + snapshot.text.length).filter(mention => mention.tier === 'uncertain').flatMap(mention => {
      const input = this.linkInput(session, mention);
      if (!input || this.verdicts.has(this.verdictKey(input))) return [];
      const end = input.anchor.contextFrom + input.anchor.contextText.length;
      return snapshot.dirtyRanges!.some(range => range.from <= end && range.to >= input.anchor.contextFrom) ? [input] : [];
    }).slice(0, 6);
    if (!inputs.length) { session.acknowledgeAnalysis(snapshot); return; }
    const scopes = inputs.map(input => this.linkScope(input, true));
    try {
      const proposals = await this.recommender.propose(inputs, this.context('link'), { key: 'link:' + id, priority: 'link', automatic: true, isCurrent: () => scopes.every(current => current()) });
      if (!scopes.every(current => current())) return;
      proposals.forEach((proposal, index) => this.remember(this.verdictKey(inputs[index]!), proposal.selected));
      if (session.currentRevision === snapshot.revision) session.acknowledgeAnalysis(snapshot);
      this.events.emit();
    } catch { /* Automatic checks stay quiet; hovering can still ask. */ }
  }
  /** Manual command: the whole note, confident mentions directly and up to 24 uncertain ones checked in one batch. */
  async findLinks(): Promise<void> {
    const session = this.editors.active(this.activePath);
    if (!session?.path) throw new OrganizerError('missing', 'host.openEditor');
    if (!this.ready || !this.vault.linkSource(session.path)) { this.message = 'links.empty'; this.events.emit(); return; }
    session.clearSuppressions();
    const generation = ++this.findGeneration, revision = session.currentRevision, sourcePath = session.path;
    const requestRevision = this.requestRevision, linkRevision = this.linkRevision, epoch = this.index.epoch;
    const mentions = this.scanRange(session, 0, Math.min(session.length, 200000), true);
    const isCurrent = () => !this.disposed && generation === this.findGeneration && session.currentRevision === revision && session.path === sourcePath && this.activePath === sourcePath &&
      this.requestRevision === requestRevision && this.linkRevision === linkRevision && this.index.epoch === epoch && this.vault.linkSource(sourcePath);
    const head = session.head, proposals: LinkProposal[] = [];
    for (const mention of mentions.filter(item => item.tier === 'confident')) {
      const input = this.linkInput(session, mention);
      if (input) proposals.push(this.linkProposalFor(session.id, { ...mention, verdictKey: this.verdictKey(input) }));
    }
    const uncertain = mentions.filter(item => item.tier === 'uncertain').sort((a, b) => Math.abs(a.from - head) - Math.abs(b.from - head)).slice(0, 24);
    const inputs = uncertain.flatMap(mention => { const input = this.linkInput(session, mention); return input ? [input] : []; });
    if (inputs.length) {
      try {
        const scopes = inputs.map(input => this.linkScope(input));
        const verified = await this.recommender.propose(inputs, this.context('link'), { key: 'link:' + session.id, priority: 'manual', automatic: false, isCurrent: () => isCurrent() && scopes.every(current => current()) });
        if (!isCurrent() || !scopes.every(current => current())) throw new OrganizerError('stale', 'error.linkStale');
        verified.forEach((proposal, index) => this.remember(this.verdictKey(inputs[index]!), proposal.selected));
        proposals.push(...verified.filter(proposal => proposal.selected !== null));
      } catch (error) { this.report(error); if (!proposals.length) throw error; }
    }
    if (!isCurrent()) throw new OrganizerError('stale', 'error.linkStale');
    this.links = [...this.links.filter(existing => existing.input.anchor.editorSessionId !== session.id), ...proposals.sort((a, b) => a.input.anchor.from - b.input.anchor.from)];
    this.message = proposals.length ? null : 'links.empty'; this.events.emit();
  }
  searchLinkTargets(query: string, sourcePath: string) {
    const fuzzy = prepareFuzzySearch(query.trim());
    return searchTargets(this.index, this.graph, { scorer: text => fuzzy(text)?.score ?? null, query, sourceNoteId: this.vault.id(sourcePath), sourcePath, allowed: target => this.vault.allowed(target.path) });
  }
  async verifyLinkQuery(sourcePath: string, match: string, line: string, candidates: readonly LinkTarget[], isCurrent: () => boolean): Promise<number | null> {
    const current = () => isCurrent() && this.settings().verifyOnHover && this.vault.linkSource(sourcePath) && candidates.every(target => this.currentTarget(target));
    if (!current()) throw new OrganizerError('stale', 'error.linkStale');
    const at = line.indexOf(match), noteId = this.vault.id(sourcePath) ?? -1;
    const input: LinkInput = { catalogueEpoch: this.index.epoch, candidates: candidates.slice(0, 8), anchor: { editorSessionId: 'query', noteId, sourcePath, documentRevision: 0, from: Math.max(0, at), to: Math.max(0, at) + match.length, originalText: match, contextFrom: 0, contextText: at >= 0 ? line : match } };
    const scope = this.linkScope(input);
    const [proposal] = await this.recommender.propose([input], this.context('link'), { key: 'query:' + sourcePath, priority: 'manual', automatic: false, linkAllowance: true, isCurrent: () => current() && scope() });
    if (!current() || !scope()) throw new OrganizerError('stale', 'error.linkStale');
    return proposal?.selected ?? null;
  }
  private currentTarget(target: LinkTarget): boolean {
    const current = this.index.get(target.noteId);
    return current?.revision === target.revision && current.path === target.path && this.vault.allowed(target.path);
  }
  linkMarkdown(target: LinkTarget, sourcePath: string, alias?: string): string {
    if (!this.vault.linkSource(sourcePath) || !this.currentTarget(target)) throw new OrganizerError('stale', 'error.linkTargetChanged');
    const file = this.vault.file(target.path);
    if (!file) throw new OrganizerError('missing', 'error.linkTargetChanged');
    return this.plugin.app.fileManager.generateMarkdownLink(file, sourcePath, undefined, alias);
  }
  prepareLink(proposal: LinkProposal, target: number): LinkPlan { return this.linker.prepare(proposal, target); }
  confirmLinks(plans: readonly LinkPlan[]): LinkConfirmation {
    const result = this.linker.confirmMany(plans.map(plan => plan.id));
    const applied = new Set(plans.filter(plan => result.appliedPlanIds.includes(plan.id)).map(plan => plan.proposalId));
    this.links = this.links.filter(item => !applied.has(item.id)); this.events.emit(); return result;
  }
  confirmLink(plan: LinkPlan): void { const result = this.confirmLinks([plan]); if (result.failures[0]) throw result.failures[0].error; }
  dismissLink(proposal: LinkProposal): void { this.editors.get(proposal.input.anchor.editorSessionId)?.suppress(proposal.input.anchor, proposal.selected); this.links = this.links.filter(item => item.id !== proposal.id); this.events.emit(); }
  nextInboxNote(exclude?: string): string | null {
    const open = this.filing.filter(entry => entry.path !== exclude && !['done', 'moving', 'ignored', 'review'].includes(entry.status) && this.vault.file(entry.path) && this.vault.eligible(entry.path));
    return (open.find(entry => entry.status === 'ready') ?? open[0])?.path ?? null;
  }
  attachmentCount(path: string): number {
    const file = this.vault.file(path), cache = file && this.plugin.app.metadataCache.getFileCache(file);
    const attachments = new Set<string>();
    for (const embed of cache?.embeds ?? []) {
      const target = this.plugin.app.metadataCache.getFirstLinkpathDest(parseLinktext(embed.link).path, path);
      if (target && target.extension !== 'md') attachments.add(target.path);
    }
    return attachments.size;
  }
  openNote(path: string): void { void this.plugin.app.workspace.openLinkText(path, this.activePath ?? '', false); }
  target(id: number) { return this.index.get(id); }
  async testConnection(): Promise<void> { await this.settingsWrite; const requestRevision = this.requestRevision; this.scheduler.setPaused(false); await this.scheduler.evaluate({ modelId: this.settings().modelId, state: 'A short example about learning.', questions: [{ id: 'connection', instructions: 'Choose the matching subject.', options: [{ id: 'learning', description: 'Learning and reading' }, { id: 'none', description: 'Other' }] }] }, { key: 'connection', priority: 'manual', automatic: false, isCurrent: () => !this.disposed && this.requestRevision === requestRevision }); }
  private report(error: unknown): void { this.message = messageFor(error); this.events.emit(); }
  private assertActive(): void { if (this.disposed) throw new OrganizerError('cancelled', 'error.analysisStopped'); }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new OrganizerError('cancelled', 'error.analysisStopped'));
    const pending = Promise.resolve().then(operation); this.operations.add(pending);
    void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending));
    return pending;
  }
  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.disposed = true; this.generation++; this.scheduler?.dispose(); this.queue?.dispose(); this.editors.dispose(); this.index.clear(); this.graph.clear(); this.verdicts.clear(); this.profiles.clear(); this.profilePaths.clear(); this.excerpts.clear(); this.events.clear();
    this.shutdown = this.drain().finally(() => this.lifecycle?.release());
    return this.shutdown;
  }
  private async drain(): Promise<void> {
    // Initialization and confirmed moves may enqueue journal writes after a read
    // or rename. Disposed schedulers leave late HTTP responses as unknown usage.
    await Promise.allSettled([this.initialization, ...this.operations]);
    await Promise.allSettled([this.settingsWrite, this.queue?.flush()]);
    await this.store.flush();
  }
}
