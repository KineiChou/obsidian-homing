import { Emitter } from '../core/events';
import { messageFor } from '../core/errors';
import { within } from '../core/paths';
import type { FilingEntry, FilingStatus, InboxQueue, InboxQueueDependencies, PersistedFilingEntry } from './types';

interface Pending { readonly token: object; readonly due: number; readonly automatic: boolean }
export class StableInboxQueue implements InboxQueue {
  private readonly items = new Map<string, FilingEntry>();
  private readonly pending = new Map<string, Pending>();
  private readonly versions = new Map<string, object>();
  private readonly events = new Emitter();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private persistence: Promise<void> = Promise.resolve();
  constructor(private readonly deps: InboxQueueDependencies) {}
  entries(): readonly FilingEntry[] { return structuredClone([...this.items.values()]); }
  subscribe(listener: () => void): () => void { return this.events.subscribe(listener); }
  restore(entries: readonly PersistedFilingEntry[]): void {
    for (const entry of entries) if (this.deps.eligible(entry.path)) this.items.set(entry.path, { path: entry.path, status: entry.status === 'ignored' ? 'ignored' : 'waiting', updatedAt: Date.now(), message: null });
    this.events.emit();
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
  analyze(path: string): void {
    if (this.stopped || !this.deps.eligible(path) || this.items.get(path)?.status === 'ignored') return;
    this.cancel(path);
    this.items.set(path, { path, status: 'waiting', updatedAt: Date.now(), message: null });
    this.schedule(path, false, Date.now()); this.changed();
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
  invalidate(): void {
    for (const [path, entry] of this.items) {
      this.cancel(path);
      if (!this.deps.eligible(path)) this.items.delete(path);
      else if (!['ignored', 'done', 'review', 'moving'].includes(entry.status)) this.items.set(path, { path, status: 'waiting', updatedAt: Date.now(), message: null });
    }
    this.changed(); this.arm();
  }
  dispose(): void { this.stopped = true; if (this.timer !== undefined) clearTimeout(this.timer); this.pending.clear(); this.versions.clear(); this.events.clear(); }
  private cancel(path: string): void { this.pending.delete(path); this.versions.delete(path); }
  private schedule(path: string, automatic: boolean, due: number): void { const token = {}; this.versions.set(path, token); this.pending.set(path, { token, automatic, due }); this.arm(); }
  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || this.pending.size === 0) return;
    let next = Infinity; for (const item of this.pending.values()) next = Math.min(next, item.due);
    this.timer = setTimeout(() => { this.timer = undefined; this.tick(); }, Math.max(0, next - Date.now()));
  }
  private tick(): void {
    for (const [path, work] of this.pending) {
      if (work.due > Date.now()) continue;
      if (!this.deps.eligible(path) || (work.automatic && !this.deps.automaticEnabled())) { this.cancel(path); continue; }
      if (work.automatic && this.deps.isEditing(path)) { this.pending.set(path, { ...work, due: Date.now() + Math.max(1, this.deps.stableMs ?? 10000) }); continue; }
      this.pending.delete(path);
      void this.run(path, work);
    }
    this.arm();
  }
  private async run(path: string, work: Pending): Promise<void> {
    const current = () => !this.stopped && this.versions.get(path) === work.token && this.deps.eligible(path) && (!work.automatic || this.deps.automaticEnabled());
    this.items.set(path, { path, status: 'analyzing', updatedAt: Date.now(), message: null }); this.events.emit();
    try {
      const proposal = await this.deps.propose(path, work.automatic, current);
      if (!current()) return;
      this.items.set(path, { path, status: proposal.selected === null ? 'unassigned' : 'ready', proposal, updatedAt: Date.now(), message: null });
    } catch (error) {
      if (!current()) return;
      this.items.set(path, { path, status: 'failed', updatedAt: Date.now(), message: messageFor(error) });
    }
    if (current()) this.changed();
  }
  private changed(): void {
    if (this.stopped) return;
    this.events.emit();
    const entries: PersistedFilingEntry[] = [...this.items.values()].filter(item => item.status !== 'done').map(item => ({ path: item.path, status: item.status === 'ignored' ? 'ignored' : 'pending' }));
    this.persistence = this.persistence.then(() => this.deps.persist(entries)).catch(() => {
      if (this.stopped) return;
      for (const [path, entry] of this.items) this.items.set(path, { ...entry, message: '待办保存失败，请检查存储后重试。' });
      this.events.emit();
    });
  }
}
