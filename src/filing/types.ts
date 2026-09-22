import type { Unsubscribe } from '../core/events';
import type { DecisionContext, RequestScope } from '../jev/types';
import type { FolderSnapshot } from '../folders/types';
export interface SourceVersion { readonly noteId: number; readonly path: string; readonly revision: number; readonly contentHash: string }
export interface NoteSnapshot { readonly source: SourceVersion; readonly title: string; readonly body: string; readonly tags: readonly string[] }
export interface FilingProposal { readonly id: string; readonly source: SourceVersion; readonly foldersRevision: number; readonly context: DecisionContext; readonly selected: string | null; readonly ranked: readonly { readonly targetId: string; readonly probability: number }[] }
export interface FolderClassifier { propose(note: NoteSnapshot, folders: FolderSnapshot, context: DecisionContext, scope: RequestScope): Promise<FilingProposal> }
export type FilingStatus = 'waiting' | 'analyzing' | 'ready' | 'unassigned' | 'failed' | 'ignored' | 'moving' | 'done' | 'review';
export interface FilingEntry { readonly path: string; readonly status: FilingStatus; readonly updatedAt: number; readonly message: string | null; readonly proposal?: FilingProposal; readonly moveRecordId?: string }
export interface PersistedFilingEntry { readonly path: string; readonly status: 'pending' | 'ignored'; }
export interface InboxQueue {
  entries(): readonly FilingEntry[];
  restore(entries: readonly PersistedFilingEntry[]): void;
  touch(path: string, automatic: boolean): void;
  analyze(path: string): void;
  remove(path: string): void;
  rename(oldPath: string, newPath: string): void;
  ignore(path: string): void;
  resume(path: string): void;
  mark(path: string, status: FilingStatus, message?: string, moveRecordId?: string): void;
  invalidate(): void;
  subscribe(listener: () => void): Unsubscribe;
  dispose(): void;
}
export interface InboxQueueDependencies {
  eligible(path: string): boolean;
  automaticEnabled(): boolean;
  isEditing(path: string): boolean;
  propose(path: string, automatic: boolean, isCurrent: () => boolean): Promise<FilingProposal>;
  persist(entries: readonly PersistedFilingEntry[]): Promise<void>;
  readonly stableMs?: number;
}
export interface MovePlan { readonly id: string; readonly source: SourceVersion; readonly destination: string; readonly folderId: string; readonly foldersRevision: number; readonly settingsRevision: number }
export interface MoveRecord { readonly id: string; readonly noteId: number; readonly from: string; readonly to: string; readonly contentHash: string; readonly createdAt: number; readonly status: 'intent' | 'done' | 'undone' | 'review'; readonly message?: string }
export type MoveResult = { readonly status: 'done'; readonly record: MoveRecord } | { readonly status: 'stale' | 'conflict' | 'failed' | 'review'; readonly message: string };
export interface MoveHost {
  source(path: string): Promise<SourceVersion | null>;
  currentPath(noteId: number): string | null;
  exists(path: string): boolean;
  eligible(path: string): boolean;
  referencesSafe(path: string, destination: string): boolean;
  rename(from: string, to: string): Promise<void>;
  folders(): FolderSnapshot;
  settingsRevision(): number;
}
export interface MoveJournal { records(): readonly MoveRecord[]; put(record: MoveRecord): Promise<void> }
export interface MoveService {
  prepare(path: string, folderId: string): Promise<MovePlan>;
  confirm(planId: string): Promise<MoveResult>;
  undo(recordId: string): Promise<MoveResult>;
  recover(): Promise<void>;
}
