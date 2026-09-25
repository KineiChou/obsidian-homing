import { OrganizerError } from '../core/errors';
import { filename, safePath } from '../core/paths';
import type { MoveHost, MoveJournal, MovePlan, MoveRecord, MoveResult, MoveService, SourceVersion } from './types';

const stale = (): MoveResult => ({ status: 'stale', message: 'error.moveStale' });
const conflict = (): MoveResult => ({ status: 'conflict', message: 'error.moveConflict' });
const review = (): MoveResult => ({ status: 'review', message: 'error.moveReview' });
const same = (a: SourceVersion, b: SourceVersion): boolean => a.noteId === b.noteId && a.path === b.path && a.revision === b.revision && a.contentHash === b.contentHash;
export class ConfirmedMoveService implements MoveService {
  private readonly plans = new Map<string, MovePlan>();
  private readonly locks = new Map<number, Promise<void>>();
  private readonly uncertain = new Set<string>();
  private counter = 0;
  private readonly undoable = new Set<string>();
  constructor(private readonly host: MoveHost, private readonly journal: MoveJournal) {}
  async prepare(path: string, folderId: string): Promise<MovePlan> {
    safePath(path);
    const folders = this.host.folders();
    const settingsRevision = this.host.settingsRevision();
    const folder = folders.targets.find(target => target.id === folderId);
    if (!folder || !this.host.eligible(path)) throw new OrganizerError('stale', 'error.moveStale');
    const destination = safePath(folder.path + '/' + filename(path));
    const source = await this.host.source(path);
    if (!source || source.path !== path || this.host.currentPath(source.noteId) !== path || folders.revision !== this.host.folders().revision || settingsRevision !== this.host.settingsRevision()) throw new OrganizerError('stale', 'error.moveStale');
    if (this.host.exists(destination)) throw new OrganizerError('conflict', 'error.moveConflict');
    const referenceIssue = this.referenceIssue(path, destination);
    if (referenceIssue) throw new OrganizerError('unsafe', referenceIssue);
    const plan: MovePlan = { id: `move-${Date.now()}-${++this.counter}`, source: { ...source }, destination, folderId, foldersRevision: folders.revision, settingsRevision };
    if (this.plans.size >= 100) this.plans.delete(this.plans.keys().next().value as string);
    this.plans.set(plan.id, plan);
    return structuredClone(plan);
  }
  async confirm(planId: string): Promise<MoveResult> {
    const plan = this.plans.get(planId);
    if (!plan) return stale();
    this.plans.delete(planId);
    return this.serial(plan.source.noteId, async () => {
      const check = await this.validate(plan);
      if (check) return check;
      const record: MoveRecord = { id: plan.id, noteId: plan.source.noteId, from: plan.source.path, to: plan.destination, contentHash: plan.source.contentHash, createdAt: Date.now(), status: 'intent' };
      try { await this.journal.put(record); } catch { return { status: 'failed', message: 'error.moveJournal' }; }
      const recheck = await this.validate(plan);
      if (recheck) { await this.markReview(record); return recheck; }
      try { await this.host.rename(record.from, record.to); } catch { await this.markReview(record); return review(); }
      const done: MoveRecord = { ...record, status: 'done' };
      try {
        await this.journal.put(done);
        const retained = new Set(this.journal.records().filter(item => item.status === 'done').map(item => item.id));
        for (const id of this.undoable) if (!retained.has(id)) this.undoable.delete(id);
        this.undoable.add(done.id);
        return { status: 'done', record: done };
      }
      catch { this.uncertain.add(record.id); return review(); }
    });
  }
  async undo(recordId: string): Promise<MoveResult> {
    const record = this.journal.records().find(item => item.id === recordId);
    if (!record || !this.undoable.has(recordId) || record.status !== 'done' || this.uncertain.has(recordId)) return stale();
    return this.serial(record.noteId, async () => {
      const latest = this.journal.records().find(item => item.id === recordId);
      if (latest?.status !== 'done' || this.uncertain.has(recordId)) return stale();
      if (this.host.currentPath(record.noteId) !== record.to || this.host.exists(record.from)) return this.host.exists(record.from) ? conflict() : stale();
      const source = await this.host.source(record.to);
      if (!source || source.noteId !== record.noteId || source.path !== record.to) return stale();
      const referenceIssue = this.referenceIssue(record.to, record.from);
      if (referenceIssue) return { status: 'failed', message: referenceIssue };
      // A reverse intent records the latest content; undo never restores an old body.
      const intent: MoveRecord = { ...record, id: `undo-${record.id}-${++this.counter}`, from: record.to, to: record.from, contentHash: source.contentHash, createdAt: Date.now(), status: 'intent' };
      try { await this.journal.put(intent); } catch { return { status: 'failed', message: 'error.undoJournal' }; }
      const current = await this.host.source(record.to);
      if (!current || !same(source, current) || this.host.currentPath(record.noteId) !== record.to || this.host.exists(record.from)) { await this.markReview(intent); return stale(); }
      const recheckReferences = this.referenceIssue(record.to, record.from);
      if (recheckReferences) { await this.markReview(intent); return { status: 'failed', message: recheckReferences }; }
      this.uncertain.add(recordId);
      try { await this.host.rename(record.to, record.from); } catch { await this.markReview(intent); return review(); }
      const undone: MoveRecord = { ...record, status: 'undone' };
      try { await this.journal.put(undone); await this.journal.put({ ...intent, status: 'undone' }); this.uncertain.delete(recordId); return { status: 'done', record: undone }; }
      catch { this.uncertain.add(recordId); this.uncertain.add(intent.id); return review(); }
    });
  }
  async recover(): Promise<void> {
    for (const record of this.journal.records()) {
      if (record.status === 'done' && !this.undoable.has(record.id)) {
        await this.journal.put({ ...record, status: 'archived', message: 'move.previousCompleted' });
        continue;
      }
      if (record.status !== 'intent') continue;
      // Recovery never uses persisted session IDs to authorize a write or undo.
      const from = await this.host.source(record.from);
      const to = await this.host.source(record.to);
      const completed = !from && !this.host.exists(record.from) && to?.contentHash === record.contentHash;
      const cancelled = from?.contentHash === record.contentHash && !to && !this.host.exists(record.to);
      await this.journal.put({ ...record, status: completed || cancelled ? 'archived' : 'review', message: completed ? 'move.completedVerified' : cancelled ? 'move.notCompleted' : 'move.changedReview' });
    }
  }
  async acknowledge(recordId: string): Promise<void> {
    const record = this.journal.records().find(item => item.id === recordId);
    if (record?.status === 'review') await this.journal.put({ ...record, status: 'archived', message: 'move.manuallyReviewed' });
  }
  private async validate(plan: MovePlan): Promise<MoveResult | null> {
    const current = await this.host.source(plan.source.path);
    const folders = this.host.folders();
    const folder = folders.targets.find(item => item.id === plan.folderId);
    if (!current || !same(current, plan.source) || this.host.currentPath(current.noteId) !== plan.source.path || !this.host.eligible(plan.source.path) || folders.revision !== plan.foldersRevision || this.host.settingsRevision() !== plan.settingsRevision || !folder || folder.path + '/' + filename(plan.source.path) !== plan.destination) return stale();
    if (this.host.exists(plan.destination)) return conflict();
    const referenceIssue = this.referenceIssue(plan.source.path, plan.destination);
    if (referenceIssue) return { status: 'failed', message: referenceIssue };
    return null;
  }
  private referenceIssue(from: string, to: string): string | null {
    const result = this.host.referencesSafe(from, to);
    return result === true ? null : typeof result === 'string' && result ? result : 'error.moveLinks';
  }
  private async markReview(record: MoveRecord): Promise<void> { this.uncertain.add(record.id); try { await this.journal.put({ ...record, status: 'review', message: 'error.moveCheckLocation' }); } catch { /* Durable intent remains available for recovery. */ } }
  private async serial(noteId: number, operation: () => Promise<MoveResult | void>): Promise<MoveResult> {
    const previous = this.locks.get(noteId) ?? Promise.resolve();
    const task = previous.then(operation).catch((): MoveResult => ({ status: 'review', message: 'error.operationReview' }));
    const settled = task.then(() => undefined);
    this.locks.set(noteId, settled);
    void settled.then(() => { if (this.locks.get(noteId) === settled) this.locks.delete(noteId); });
    return (await task) ?? stale();
  }
}
