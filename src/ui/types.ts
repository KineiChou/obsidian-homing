import type { OrganizerSettings } from '../settings';
import type { Unsubscribe } from '../core/events';
import type { FilingEntry, MovePlan, MoveRecord } from '../filing/types';
import type { FolderTarget } from '../folders/types';
import type { LinkProposal, LinkPlan, LinkTarget } from '../linking/types';
import type { DailyUsage, SchedulerStatus } from '../jev/types';
export interface ReviewState { readonly filing: readonly FilingEntry[]; readonly links: readonly LinkProposal[]; readonly activePath: string | null; readonly network: SchedulerStatus; readonly indexReady: boolean; readonly message: string | null }
export interface OrganizerController {
  state(): ReviewState;
  subscribe(listener: () => void): Unsubscribe;
  settings(): OrganizerSettings;
  saveSettings(value: OrganizerSettings): Promise<void>;
  enabled(): boolean;
  setEnabled(enabled: boolean): void;
  testConnection(): Promise<void>;
  usage(): DailyUsage;
  folders(): readonly FolderTarget[];
  allFolders(): readonly string[];
  createInbox(path: string): Promise<void>;
  analyzeInbox(): void;
  analyzeNote(path: string): void;
  ignoreNote(path: string): void;
  restoreIgnored(): void;
  prepareMove(path: string, target: string): Promise<MovePlan>;
  confirmMove(plan: MovePlan): Promise<void>;
  undoMove(id: string): Promise<void>;
  recentMoves(): readonly MoveRecord[];
  findLinks(): Promise<void>;
  prepareLink(proposal: LinkProposal, target: number): LinkPlan;
  confirmLink(plan: LinkPlan): void;
  dismissLink(proposal: LinkProposal): void;
  openNote(path: string): void;
  target(id: number): LinkTarget | undefined;
}
