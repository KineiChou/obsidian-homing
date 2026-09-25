import { Emitter } from '../core/events';
import { OrganizerError, messageFor } from '../core/errors';
import { within } from '../core/paths';
import type { FilingContentSource, FilingEntry, FilingProposal, FilingStatus, InboxQueue, InboxQueueDependencies, PersistedFilingEntry } from './types';

/** `refresh` work re-analyzes a note that already has a suggestion and keeps that suggestion unless a new one arrives. */
interface Pending { readonly token: object; readonly due: number; readonly automatic: boolean; readonly contentSource: FilingContentSource; readonly refresh?: boolean }
export class StableInboxQueue implements InboxQueue {
  private readonly items = new Map<string, FilingEntry>();
  private readonly pending = new Map<string, Pending>();
  private readonly versions = new Map<string, object>();
  private readonly refreshing = new Set<string>();
  private readonly events = new Emitter();
  private timer: number | undefined;
  private stopped = false;
  private running = false;
  private persistence: Promise<void> = Promise.resolve();
  constructor(private readonly deps: InboxQueueDependencies) {}
  entries(): readonly FilingEntry[] { return structuredClone([...this.items.values()]); }
  subscribe(listener: () => void): () => void { return this.events.subscribe(listener); }
  async restore(entries: readonly PersistedFilingEntry[]): Promise<void> {
    await Promise.all(entries.map(async entry => {
      if (this.stopped || !this.deps.eligible(entry.path) || this.items.has(entry.path)) return;
      const token = {}; this.versions.set(entry.path, token);
      this.items.set(entry.path, { path: entry.path, status: entry.status === 'ignored' ? 'ignored' : 'waiting', updatedAt: Date.now(), message: null });
      if (entry.status === 'ignored' || !entry.proposal || !this.deps.restoreProposal) return;
      let proposal: FilingProposal | null = null;
      try { proposal = await this.deps.restoreProposal(entry.path, entry.proposal); } catch { /* Invalid or unavailable sources remain waiting. */ }
      if (this.stopped || this.versions.get(entry.path) !== token || !this.deps.eligible(entry.path)) return;
      if (proposal) this.items.set(entry.path, { path: entry.path, status: proposal.selected === null ? 'unassigned' : 'ready', proposal, updatedAt: Date.now(), message: null });
    }));
    if (!this.stopped) this.events.emit();
  }
  touch(path: string, automatic: boolean): void {
    if (this.stopped) return;
    if (!this.deps.eligible(path)) { this.remove(path); return; }
    if (this.items.get(path)?.status === 'ignored') return;
    this.cancel(path);
    this.items.set(path, { path, status: 'waiting', updatedAt: Date.now(), message: null });
    if (!automatic || this.deps.automaticEnabled()) this.schedule(path, automatic, Date.now() + (this.deps.stableMs ?? 10000));
    this.changed();
  }
  analyze(path: string, contentSource: FilingContentSource = 'editor'): void {
    if (this.stopped || !this.deps.eligible(path) || this.items.get(path)?.status === 'ignored') return;
    this.cancel(path);
    this.items.set(path, { path, status: 'analyzing', updatedAt: Date.now(), message: null });
    this.schedule(path, false, Date.now(), contentSource); this.changed();
  }
  remove(path: string): void {
    for (const key of this.items.keys()) if (within(key, path)) { this.cancel(key); this.items.delete(key); }
    this.changed(); this.arm();
  }
  rename(oldPath: string, newPath: string): void {
    for (const [path, entry] of [...this.items]) if (within(path, oldPath)) {
      const next = newPath + path.slice(oldPath.length);
      this.cancel(path); this.items.delete(path);
      if (this.deps.eligible(next)) this.items.set(next, { path: next, status: entry.status === 'ignored' ? 'ignored' : 'waiting', updatedAt: Date.now(), message: null });
    }
    this.changed(); this.arm();
  }
  ignore(path: string): void { if (!this.items.has(path)) return; this.cancel(path); this.items.set(path, { path, status: 'ignored', updatedAt: Date.now(), message: null }); this.changed(); this.arm(); }
  resume(path: string): void { if (this.items.get(path)?.status !== 'ignored') return; this.items.set(path, { path, status: 'waiting', updatedAt: Date.now(), message: null }); this.changed(); }
  mark(path: string, status: FilingStatus, message?: string, moveRecordId?: string): void {
    if (this.stopped || (!this.items.has(path) && status !== 'done' && status !== 'review')) return;
    this.cancel(path);
    this.items.set(path, { path, status, updatedAt: Date.now(), message: message ?? null, ...(moveRecordId ? { moveRecordId } : {}) });
    this.changed(); this.arm();
  }
  invalidate(preserve?: (proposal: FilingProposal) => FilingProposal | null, options: { readonly reanalyze?: boolean } = {}): void {
    for (const [path, entry] of this.items) {
      const needsAnalysis = Boolean(entry.proposal) || entry.status === 'analyzing' || this.pending.has(path);
      // A refresh cancelled by a later change (e.g. the new folder is renamed) is scheduled again.
      const refresh = (options.reanalyze || this.pending.get(path)?.refresh || this.refreshing.has(path)) && this.deps.automaticEnabled();
      this.cancel(path);
      if (!this.deps.eligible(path)) this.items.delete(path);
      else if (!['ignored', 'done', 'review', 'moving'].includes(entry.status)) {
        const proposal = entry.proposal && preserve?.(entry.proposal);
        if (proposal) {
          this.items.set(path, { ...entry, proposal, status: proposal.selected === null ? 'unassigned' : 'ready' });
          if (refresh) this.schedule(path, true, Date.now() + (this.deps.stableMs ?? 10000), 'saved', true);
        }
        else {
          this.items.set(path, { path, status: 'waiting', updatedAt: Date.now(), message: null });
          if (needsAnalysis && this.deps.automaticEnabled()) this.schedule(path, true, Date.now() + (this.deps.stableMs ?? 10000));
        }
      }
    }
    this.changed(); this.arm();
  }
  flush(): Promise<void> { return this.persistence; }
  dispose(): void { this.stopped = true; if (this.timer !== undefined) window.clearTimeout(this.timer); this.pending.clear(); this.versions.clear(); this.events.clear(); }
  private cancel(path: string): void { this.pending.delete(path); this.versions.delete(path); this.refreshing.delete(path); }
  private schedule(path: string, automatic: boolean, due: number, contentSource: FilingContentSource = automatic ? 'saved' : 'editor', refresh = false): void { const token = {}; this.versions.set(path, token); this.pending.set(path, { token, automatic, due, contentSource, ...(refresh ? { refresh } : {}) }); this.arm(); }
  private arm(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || this.running || this.pending.size === 0) return;
    let next = Infinity; for (const item of this.pending.values()) next = Math.min(next, item.due);
    this.timer = window.setTimeout(() => { this.timer = undefined; this.tick(); }, Math.max(0, next - Date.now()));
  }
  private tick(): void {
    for (const [path, work] of this.pending) {
      if (work.due > Date.now()) continue;
      if (!this.deps.eligible(path) || (work.automatic && !this.deps.automaticEnabled())) { this.cancel(path); continue; }
      if (work.automatic && this.deps.isEditing(path)) { this.pending.set(path, { ...work, due: Date.now() + Math.max(1, this.deps.stableMs ?? 10000) }); continue; }
      this.pending.delete(path);
      this.running = true;
      void this.run(path, work).finally(() => { this.running = false; this.arm(); });
      break;
    }
    this.arm();
  }
  private async run(path: string, work: Pending): Promise<void> {
    const current = () => !this.stopped && this.versions.get(path) === work.token && this.deps.eligible(path) && (!work.automatic || this.deps.automaticEnabled());
    const refresh = work.refresh === true && this.items.get(path)?.proposal !== undefined;
    if (refresh) this.refreshing.add(path);
    else { this.items.set(path, { path, status: 'analyzing', updatedAt: Date.now(), message: null }); this.events.emit(); }
    try {
      const proposal = await this.deps.propose(path, work.automatic, current, work.contentSource);
      if (!current()) return;
      this.items.set(path, { path, status: proposal.selected === null ? 'unassigned' : 'ready', proposal, updatedAt: Date.now(), message: null });
    } catch (error) {
      if (!current()) return;
      // A failed refresh keeps the suggestion the user already has.
      if (!refresh) this.items.set(path, { path, status: error instanceof OrganizerError && error.code === 'budget' ? 'waiting' : 'failed', updatedAt: Date.now(), message: messageFor(error) });
    } finally { if (this.versions.get(path) === work.token) this.refreshing.delete(path); }
    if (current()) this.changed();
  }
  private changed(): void {
    if (this.stopped) return;
    this.events.emit();
    const entries: PersistedFilingEntry[] = [...this.items.values()].filter(item => item.status !== 'done').map(item => {
      const proposal = item.proposal && this.deps.encodeProposal?.(item.proposal);
      return { path: item.path, status: item.status === 'ignored' ? 'ignored' : 'pending', ...(proposal ? { proposal } : {}) };
    });
    this.persistence = this.persistence.then(() => this.deps.persist(entries)).catch(() => {
      if (this.stopped) return;
      for (const [path, entry] of this.items) this.items.set(path, { ...entry, message: 'error.queueStorage' });
      this.events.emit();
    });
  }
}
