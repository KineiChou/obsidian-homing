import { OrganizerError } from '../core/errors';
import { filename, safePath } from '../core/paths';
import type { MoveHost, MoveJournal, MovePlan, MoveRecord, MoveResult, MoveService, SourceVersion } from './types';

const stale = (): MoveResult => ({ status: 'stale', message: '笔记或目录已变化，请重新选择归档位置。' });
const conflict = (): MoveResult => ({ status: 'conflict', message: '目标位置已有同名文件，请选择其他位置。' });
const review = (): MoveResult => ({ status: 'review', message: '移动结果需要核对，请检查笔记当前位置。' });
const same = (a: SourceVersion, b: SourceVersion): boolean => a.noteId === b.noteId && a.path === b.path && a.revision === b.revision && a.contentHash === b.contentHash;
export class ConfirmedMoveService implements MoveService {
  private readonly plans = new Map<string, MovePlan>();
  private readonly locks = new Map<number, Promise<void>>();
  private readonly uncertain = new Set<string>();
  private counter = 0;
  constructor(private readonly host: MoveHost, private readonly journal: MoveJournal) {}
  async prepare(path: string, folderId: string): Promise<MovePlan> {
    safePath(path);
    const folders = this.host.folders();
    const settingsRevision = this.host.settingsRevision();
    const folder = folders.targets.find(target => target.id === folderId);
    if (!folder || !this.host.eligible(path)) throw new OrganizerError('stale', '笔记或目录已变化，请重新选择归档位置。');
    const destination = safePath(folder.path + '/' + filename(path));
    const source = await this.host.source(path);
    if (!source || source.path !== path || this.host.currentPath(source.noteId) !== path || folders.revision !== this.host.folders().revision || settingsRevision !== this.host.settingsRevision()) throw new OrganizerError('stale', '笔记或目录已变化，请重新选择归档位置。');
    if (this.host.exists(destination)) throw new OrganizerError('conflict', '目标位置已有同名文件，请选择其他位置。');
    if (!this.host.referencesSafe(path, destination)) throw new OrganizerError('unsafe', '移动可能改变现有链接，请先核对链接。');
    const plan: MovePlan = { id: `move-${Date.now()}-${++this.counter}`, source: { ...source }, destination, folderId, foldersRevision: folders.revision, settingsRevision };
    for (const [id, existing] of this.plans) if (existing.source.noteId === source.noteId) this.plans.delete(id);
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
      try { await this.journal.put(record); } catch { return { status: 'failed', message: '移动记录无法保存，笔记尚未移动。' }; }
      const recheck = await this.validate(plan);
      if (recheck) { await this.markReview(record); return recheck; }
      try { await this.host.rename(record.from, record.to); } catch { await this.markReview(record); return review(); }
      const done: MoveRecord = { ...record, status: 'done' };
      try { await this.journal.put(done); return { status: 'done', record: done }; }
      catch { this.uncertain.add(record.id); return review(); }
    });
  }
  async undo(recordId: string): Promise<MoveResult> {
    const record = this.journal.records().find(item => item.id === recordId);
    if (!record || record.status !== 'done' || this.uncertain.has(recordId)) return stale();
    return this.serial(record.noteId, async () => {
      const latest = this.journal.records().find(item => item.id === recordId);
      if (latest?.status !== 'done' || this.uncertain.has(recordId)) return stale();
      if (this.host.currentPath(record.noteId) !== record.to || this.host.exists(record.from)) return this.host.exists(record.from) ? conflict() : stale();
      const source = await this.host.source(record.to);
      if (!source || source.noteId !== record.noteId || source.path !== record.to || !this.host.referencesSafe(record.to, record.from)) return stale();
      // A reverse intent records the latest content; undo never restores an old body.
      const intent: MoveRecord = { ...record, id: `undo-${record.id}-${++this.counter}`, from: record.to, to: record.from, contentHash: source.contentHash, createdAt: Date.now(), status: 'intent' };
      try { await this.journal.put(intent); } catch { return { status: 'failed', message: '撤销记录无法保存，笔记尚未移动。' }; }
      const current = await this.host.source(record.to);
      if (!current || !same(source, current) || this.host.currentPath(record.noteId) !== record.to || this.host.exists(record.from) || !this.host.referencesSafe(record.to, record.from)) { await this.markReview(intent); return stale(); }
      this.uncertain.add(recordId);
      try { await this.host.rename(record.to, record.from); } catch { await this.markReview(intent); return review(); }
      const undone: MoveRecord = { ...record, status: 'undone' };
      try { await this.journal.put(undone); await this.journal.put({ ...intent, status: 'undone' }); this.uncertain.delete(recordId); return { status: 'done', record: undone }; }
      catch { this.uncertain.add(recordId); this.uncertain.add(intent.id); return review(); }
    });
  }
  async recover(): Promise<void> {
    for (const record of this.journal.records()) {
      if (record.status === 'done') {
        await this.journal.put({ ...record, status: 'review', message: '上次会话的移动记录，请人工核对笔记身份后处理。' });
        continue;
      }
      if (record.status !== 'intent') continue;
      await this.serial(record.noteId, async () => {
        // Session IDs are not durable. Recovery inspects paths and fingerprints but
        // requires human review before granting another write or an undo identity.
        const from = await this.host.source(record.from);
        const to = await this.host.source(record.to);
        const message = !from && to?.contentHash === record.contentHash ? '目标位置发现笔记，请核对移动是否完成。' : from?.contentHash === record.contentHash && !to ? '原位置仍有笔记，请核对后重新归档。' : '笔记位置或内容已变化，请核对移动记录。';
        await this.journal.put({ ...record, status: 'review', message });
      });
    }
  }
  private async validate(plan: MovePlan): Promise<MoveResult | null> {
    const current = await this.host.source(plan.source.path);
    const folders = this.host.folders();
    const folder = folders.targets.find(item => item.id === plan.folderId);
    if (!current || !same(current, plan.source) || this.host.currentPath(current.noteId) !== plan.source.path || !this.host.eligible(plan.source.path) || folders.revision !== plan.foldersRevision || this.host.settingsRevision() !== plan.settingsRevision || !folder || folder.path + '/' + filename(plan.source.path) !== plan.destination) return stale();
    if (this.host.exists(plan.destination)) return conflict();
    if (!this.host.referencesSafe(plan.source.path, plan.destination)) return { status: 'failed', message: '移动可能改变现有链接，请先核对链接。' };
    return null;
  }
  private async markReview(record: MoveRecord): Promise<void> { this.uncertain.add(record.id); try { await this.journal.put({ ...record, status: 'review', message: '请核对笔记当前位置后再操作。' }); } catch { /* Durable intent remains available for recovery. */ } }
  private async serial(noteId: number, operation: () => Promise<MoveResult | void>): Promise<MoveResult> {
    const previous = this.locks.get(noteId) ?? Promise.resolve();
    const task = previous.then(operation).catch(() => ({ status: 'review', message: '操作结果需要核对，请检查笔记当前位置。' }) as MoveResult);
    const settled = task.then(() => undefined);
    this.locks.set(noteId, settled);
    void settled.then(() => { if (this.locks.get(noteId) === settled) this.locks.delete(noteId); });
    return (await task) ?? stale();
  }
}
