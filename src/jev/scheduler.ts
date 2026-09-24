import { OrganizerError } from '../core/errors';
import { Emitter } from '../core/events';
import { assertCurrent, serializeBatch } from './request';
import type { ChoiceBatch, ChoiceBatchResult, DecisionClient, DecisionScheduler, RequestScope, SchedulerOptions, SchedulerStatus, UsageStore } from './types';

interface Job {
  batch: ChoiceBatch;
  scope: RequestScope;
  resolve: (result: ChoiceBatchResult) => void;
  reject: (error: OrganizerError) => void;
  settled: boolean;
  attempts: number;
  readyAt: number;
}
const priority = { manual: 0, link: 1, filing: 2 };
function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(maximum, Math.max(minimum, value));
}
export class SharedDecisionScheduler implements DecisionScheduler {
  private readonly events = new Emitter();
  private readonly queue = new Map<string, Job>();
  private active: Job | null = null;
  private paused = false;
  private disposed = false;
  private reason: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastAutomatic = -Infinity;
  private readonly interval: number;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly maxPending: number;
  constructor(private readonly client: DecisionClient, private readonly usage: UsageStore, private readonly dailyLimit: () => number, options: SchedulerOptions = {}) {
    this.interval = bounded(options.minAutomaticIntervalMs, 5000, 0, 60_000);
    this.timeout = bounded(options.logicalTimeoutMs, 45_000, 1, 300_000);
    this.retries = Math.floor(bounded(options.maxRetries, 2, 0, 3));
    this.maxPending = Math.floor(bounded(options.maxPending, 128, 1, 512));
  }
  subscribe(listener: () => void): () => void { return this.events.subscribe(listener); }
  status(): SchedulerStatus { return { pending: this.queue.size, inFlight: this.active !== null, paused: this.paused, reason: this.reason }; }
  evaluate(batch: ChoiceBatch, scope: RequestScope): Promise<ChoiceBatchResult> {
    try {
      if (this.disposed) throw new OrganizerError('cancelled', 'error.analysisStopped');
      if (this.paused) throw new OrganizerError('cancelled', this.reason ?? 'error.analysisPaused');
      assertCurrent(scope);
      serializeBatch(batch);
      this.cancel(scope.key);
      if (this.queue.size >= this.maxPending) throw new OrganizerError('limit', 'error.queueFull');
    } catch (error) { return Promise.reject(this.error(error)); }
    return new Promise((resolve, reject) => {
      this.queue.set(scope.key, { batch, scope, resolve, reject, settled: false, attempts: 0, readyAt: Date.now() });
      this.events.emit();
      this.pump();
    });
  }
  cancel(key: string): void {
    const queued = this.queue.get(key);
    if (!queued && (this.active?.scope.key !== key || this.active.settled)) return;
    if (queued) { this.queue.delete(key); this.fail(queued, new OrganizerError('cancelled', 'error.analysisSuperseded')); }
    if (this.active?.scope.key === key) this.fail(this.active, new OrganizerError('cancelled', 'error.analysisCancelledSent'));
    this.events.emit();
  }
  setPaused(paused: boolean): void {
    if (this.disposed) return;
    this.paused = paused;
    this.reason = paused ? 'error.analysisPaused' : null;
    if (paused) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (this.active) this.fail(this.active, new OrganizerError('cancelled', 'error.analysisPausedSent'));
    }
    this.events.emit();
    if (!paused) this.pump();
  }
  dispose(): void {
    this.disposed = true;
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const job of this.queue.values()) this.fail(job, new OrganizerError('cancelled', 'error.analysisStopped'));
    this.queue.clear();
    if (this.active) this.fail(this.active, new OrganizerError('cancelled', 'error.analysisStopped'));
    this.events.clear();
  }
  private fail(job: Job, error: OrganizerError): void {
    if (job.settled) return;
    job.settled = true;
    job.reject(error);
  }
  private error(error: unknown): OrganizerError {
    return error instanceof OrganizerError ? error : new OrganizerError('service', 'error.analysisFailed');
  }
  private pump(): void {
    if (this.active || this.paused || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const [key, job] of this.queue) {
      if (!job.scope.isCurrent()) { this.queue.delete(key); this.fail(job, new OrganizerError('stale', 'error.analysisStale')); }
    }
    const now = Date.now();
    const readyTime = (job: Job): number => Math.max(job.readyAt, job.scope.automatic ? this.lastAutomatic + this.interval : 0);
    const jobs = [...this.queue.values()];
    const job = jobs.filter(item => readyTime(item) <= now).sort((a, b) => priority[a.scope.priority] - priority[b.scope.priority])[0];
    if (!job) {
      if (jobs.length) this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, Math.max(1, Math.min(...jobs.map(readyTime)) - now));
      this.events.emit();
      return;
    }
    this.queue.delete(job.scope.key);
    this.active = job;
    this.reason = null;
    this.events.emit();
    void this.run(job);
  }
  private async run(job: Job): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let reserved = false;
    let result: ChoiceBatchResult | undefined;
    let failure: OrganizerError | undefined;
    try {
      assertCurrent(job.scope);
      const limit = this.dailyLimit();
      if (!Number.isSafeInteger(limit) || limit < 1) throw new OrganizerError('budget', 'error.budgetExhausted');
      try { await this.usage.reserve(limit, (job.scope.automatic && job.scope.priority === 'link') || job.scope.linkAllowance ? { automaticLinkLimit: Math.floor(limit * 0.3) } : undefined); reserved = true; }
      catch (error) { throw error instanceof OrganizerError ? error : new OrganizerError('storage', 'error.budgetStorage'); }
      assertCurrent(job.scope);
      if (job.settled || this.disposed || this.paused) throw new OrganizerError('cancelled', 'error.analysisStopped');
      if (job.scope.automatic) this.lastAutomatic = Date.now();
      timeout = setTimeout(() => {
        this.reason = 'error.analysisTimeout';
        this.fail(job, new OrganizerError('timeout', this.reason));
        this.events.emit();
      }, this.timeout);
      // Keep the actual slot until evaluate settles, even after logical cancellation.
      result = await this.client.evaluate(job.batch);
      assertCurrent(job.scope);
    } catch (error) { failure = this.error(error); }
    finally {
      if (timeout) clearTimeout(timeout);
      // After unload, retain the reservation as unknown. A late HTTP response
      // must not settle through a stale usage snapshot owned by the old instance.
      if (reserved && !this.disposed) {
        try { await this.usage.settle(result?.inputTokens ?? null); }
        catch { failure = new OrganizerError('storage', 'error.usageStorage'); }
      }
      this.active = null;
    }
    if (!job.settled) {
      if (!job.scope.isCurrent()) failure = new OrganizerError('stale', 'error.analysisStale');
      if (failure) {
        const retryable = ['rate-limit', 'network', 'service'].includes(failure.code);
        if (retryable && job.attempts < this.retries && failure.retryAfterMs <= 60_000 && this.queue.size < this.maxPending && !this.disposed && !this.paused) {
          job.readyAt = Date.now() + Math.max(failure.retryAfterMs, 1000 * 2 ** job.attempts++);
          this.queue.set(job.scope.key, job);
        } else {
          this.reason = failure.message; this.fail(job, failure);
          if (failure.code === 'authentication') { this.paused = true; for (const queued of this.queue.values()) this.fail(queued, failure); this.queue.clear(); }
        }
      } else if (result) { job.settled = true; job.resolve(result); this.reason = null; }
    }
    this.events.emit();
    this.pump();
  }
}
