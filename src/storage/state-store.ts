import { OrganizerError } from '../core/errors';
import { safePath } from '../core/paths';
import { DEFAULT_SETTINGS, parseSettings } from '../settings';
import type { OrganizerSettings } from '../settings';
import type { MoveRecord, PersistedFilingEntry, PersistedFilingProposal, MoveJournal } from '../filing/types';
import type { DailyUsage, UsageStore } from '../jev/types';
import type { PersistedState, PersistencePort, StateStore } from './types';

const ENABLED = 'note-organizer-enabled';
const USAGE = 'note-organizer-usage';
const storageError = () => new OrganizerError('storage', '存储无法读取或保存，原始数据已保留。');
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw storageError(); return value as Record<string, unknown>; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function path(value: unknown): value is string { return typeof value === 'string' && safePath(value) === value; }
function parseProposal(value: unknown): PersistedFilingProposal | undefined {
  try {
    const v = object(value);
    if (typeof v.contentHash !== 'string' || !v.contentHash || (v.selectedPath !== null && !path(v.selectedPath)) || typeof v.modelId !== 'string' || !v.modelId || !integer(v.promptRevision) || typeof v.settingsFingerprint !== 'string' || !v.settingsFingerprint || !integer(v.createdAt) || !Array.isArray(v.ranked) || v.ranked.length > 3) return undefined;
    const ranked = v.ranked.map((item: unknown) => {
      const candidate = object(item);
      if (!path(candidate.path) || typeof candidate.probability !== 'number' || !Number.isFinite(candidate.probability) || candidate.probability < 0 || candidate.probability > 1) throw storageError();
      return { path: candidate.path, probability: candidate.probability };
    });
    if (new Set(ranked.map(item => item.path)).size !== ranked.length) return undefined;
    let excerpt;
    if (v.excerpt !== undefined) {
      const e = object(v.excerpt);
      if (!integer(e.originalChars) || !integer(e.sentChars) || e.sentChars > e.originalChars) return undefined;
      excerpt = { originalChars: e.originalChars, sentChars: e.sentChars };
    }
    return { contentHash: v.contentHash, selectedPath: v.selectedPath, ranked, modelId: v.modelId, promptRevision: v.promptRevision, settingsFingerprint: v.settingsFingerprint, createdAt: v.createdAt, ...(excerpt ? { excerpt } : {}) };
  } catch { return undefined; }
}
function parseQueue(value: unknown): PersistedFilingEntry[] {
  if (!Array.isArray(value)) throw storageError();
  const paths = new Set<string>();
  return value.map((item: unknown) => { const v = object(item); if (!path(v.path) || (v.status !== 'pending' && v.status !== 'ignored') || paths.has(v.path)) throw storageError(); paths.add(v.path); const proposal = v.status === 'pending' ? parseProposal(v.proposal) : undefined; return { path: v.path, status: v.status, ...(proposal ? { proposal } : {}) }; });
}
function parseRecord(value: unknown): MoveRecord {
  const v = object(value);
  if (typeof v.id !== 'string' || !v.id || !integer(v.noteId) || !path(v.from) || !path(v.to) || typeof v.contentHash !== 'string' || !v.contentHash || !integer(v.createdAt) || !['intent', 'done', 'undone', 'review', 'archived'].includes(String(v.status)) || (v.message !== undefined && typeof v.message !== 'string')) throw storageError();
  return { id: v.id, noteId: v.noteId, from: v.from, to: v.to, contentHash: v.contentHash, createdAt: v.createdAt, status: v.status as MoveRecord['status'], ...(v.message === undefined ? {} : { message: v.message as string }) };
}
function parseUsage(value: unknown): DailyUsage {
  const v = object(value);
  if (typeof v.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.day) || !integer(v.requests) || !integer(v.inputTokens) || !integer(v.unknownRequests) || v.unknownRequests > v.requests) throw storageError();
  return { day: v.day, requests: v.requests, inputTokens: v.inputTokens, unknownRequests: v.unknownRequests };
}
export class PluginStateStore implements StateStore {
  private state: PersistedState = { schemaVersion: 2, settings: structuredClone(DEFAULT_SETTINGS), filingQueue: [], moveJournal: [] };
  private ready = false;
  private tail: Promise<void> = Promise.resolve();
  private usageTail: Promise<void> = Promise.resolve();
  private usageValue: DailyUsage | undefined;
  private readonly reservations: string[] = [];
  readonly journal: MoveJournal;
  readonly usage: UsageStore;
  constructor(private readonly port: PersistencePort, private readonly now: () => Date = () => new Date()) {
    this.journal = { records: () => structuredClone(this.state.moveJournal), put: record => this.update(current => {
      const parsed = parseRecord(structuredClone(record));
      const records = current.moveJournal.filter(item => item.id !== parsed.id);
      records.push(parsed);
      const unfinished = records.filter(item => item.status === 'intent' || item.status === 'review');
      const completed = records.filter(item => item.status !== 'intent' && item.status !== 'review').slice(-100);
      return { ...current, moveJournal: [...unfinished, ...completed] };
    }) };
    this.usage = { read: () => this.readUsage(), reserve: limit => this.updateUsage(() => {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new OrganizerError('budget', '每日分析额度无效。');
      const current = this.readUsage();
      if (current.requests >= limit) throw new OrganizerError('budget', '今日分析请求已达到上限。');
      this.saveUsage({ ...current, requests: current.requests + 1, unknownRequests: current.unknownRequests + 1 });
      this.reservations.push(current.day);
    }), settle: tokens => this.updateUsage(() => {
      if (tokens !== null && !integer(tokens)) throw storageError();
      const day = this.reservations[0];
      if (!day) throw storageError();
      const current = this.readUsage();
      if (day === current.day && tokens !== null) this.saveUsage({ ...current, inputTokens: current.inputTokens + tokens, unknownRequests: Math.max(0, current.unknownRequests - 1) });
      this.reservations.shift();
    }) };
  }
  async load(): Promise<void> {
    if (this.ready) return;
    try {
      const value = await this.port.load();
      if (value != null) {
        const v = object(value);
        if ((v.schemaVersion !== 1 && v.schemaVersion !== 2) || !Array.isArray(v.moveJournal)) throw storageError();
        const settings = object(v.settings);
        for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
          if (!(key in settings) || settings[key] === null || (Array.isArray(defaultValue) ? !Array.isArray(settings[key]) : typeof settings[key] !== typeof defaultValue)) throw storageError();
        }
        const records = v.moveJournal.map(parseRecord);
        if (new Set(records.map(record => record.id)).size !== records.length) throw storageError();
        this.state = { schemaVersion: 2, settings: parseSettings(settings), filingQueue: parseQueue(v.filingQueue), moveJournal: records };
      }
      this.readUsage();
      const enabled = this.port.loadLocal(ENABLED);
      if (enabled != null && typeof enabled !== 'boolean') throw storageError();
      this.ready = true;
    } catch { throw storageError(); }
  }
  snapshot(): PersistedState { return structuredClone(this.state); }
  updateSettings(settings: OrganizerSettings): Promise<void> { const copy = structuredClone(settings); return this.update(current => ({ ...current, settings: parseSettings(copy) })); }
  updateQueue(entries: readonly PersistedFilingEntry[]): Promise<void> { const copy = structuredClone(entries); return this.update(current => ({ ...current, filingQueue: parseQueue(copy) })); }
  automaticEnabled(): boolean { return this.ready && this.port.loadLocal(ENABLED) === true; }
  setAutomaticEnabled(enabled: boolean): void { if (!this.ready) throw storageError(); try { this.port.saveLocal(ENABLED, enabled); } catch { throw storageError(); } }
  async flush(): Promise<void> { await Promise.all([this.tail, this.usageTail]); }
  private update(change: (current: PersistedState) => PersistedState): Promise<void> {
    const task = this.tail.then(async () => { if (!this.ready) throw storageError(); try { const next = change(this.state); await this.port.save(structuredClone(next)); this.state = next; } catch { throw storageError(); } });
    this.tail = task.catch(() => undefined); return task;
  }
  private day(): string { const date = this.now(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
  private readUsage(): DailyUsage {
    if (!this.usageValue) { const value = this.port.loadLocal(USAGE); this.usageValue = value == null ? { day: this.day(), requests: 0, inputTokens: 0, unknownRequests: 0 } : parseUsage(value); }
    // A backwards clock must not restore a fresh quota for an already used day.
    if (this.day() > this.usageValue.day) this.usageValue = { day: this.day(), requests: 0, inputTokens: 0, unknownRequests: 0 };
    return { ...this.usageValue };
  }
  private saveUsage(value: DailyUsage): void { try { this.port.saveLocal(USAGE, value); this.usageValue = value; } catch { throw storageError(); } }
  private updateUsage(change: () => void): Promise<void> { const task = this.usageTail.then(() => { if (!this.ready) throw storageError(); change(); }); this.usageTail = task.catch(() => undefined); return task; }
}
