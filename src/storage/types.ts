import type { OrganizerSettings } from '../settings';
import type { MoveRecord, PersistedFilingEntry, MoveJournal } from '../filing/types';
import type { UsageStore } from '../jev/types';
export interface PersistedState { readonly schemaVersion: 2; readonly settings: OrganizerSettings; readonly filingQueue: readonly PersistedFilingEntry[]; readonly moveJournal: readonly MoveRecord[] }
export interface PersistencePort { load(): Promise<unknown>; save(data: PersistedState): Promise<void>; loadLocal(key: string): unknown; saveLocal(key: string, value: unknown): void }
export interface StateStore {
  load(): Promise<void>;
  snapshot(): PersistedState;
  updateSettings(settings: OrganizerSettings): Promise<void>;
  updateQueue(entries: readonly PersistedFilingEntry[]): Promise<void>;
  readonly journal: MoveJournal;
  readonly usage: UsageStore;
  automaticEnabled(): boolean;
  setAutomaticEnabled(enabled: boolean): void;
  flush(): Promise<void>;
}
