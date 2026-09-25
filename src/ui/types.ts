import type { OrganizerSettings } from '../settings';
import type { Unsubscribe } from '../core/events';
import type { FilingEntry, MovePlan, MoveRecord } from '../filing/types';
import type { FolderTarget } from '../folders/types';
import type { LinkProposal, LinkPlan, LinkTarget, LinkConfirmation, LocalMention, TextRange } from '../linking/types';
import type { TargetMatch } from '../linking/target-search';
import type { DailyUsage, SchedulerStatus } from '../jev/types';
/** A local mention as shown in the editor; `verified` is the note a model check selected. */
export interface LinkMention extends LocalMention { readonly verdictKey: string; readonly verified?: number }
export interface ReviewState { readonly filing: readonly FilingEntry[]; readonly links: readonly LinkProposal[]; readonly activePath: string | null; readonly network: SchedulerStatus; readonly indexReady: boolean; readonly message: string | null }
export interface BatchAnalysisPreview {
  readonly notes: readonly { readonly path: string; readonly modifiedAt: number }[];
  readonly remainingRequests: number;
  readonly requestsPerNote: { readonly min: number; readonly max: number };
  readonly recommendedCount: number;
}
export interface OrganizerController {
  state(): ReviewState;
  subscribe(listener: () => void): Unsubscribe;
  settings(): OrganizerSettings;
  saveSettings(patch: Partial<OrganizerSettings>): Promise<void>;
  enabled(): boolean;
  setEnabled(enabled: boolean): void;
  testConnection(): Promise<void>;
  usage(): DailyUsage;
  folders(): readonly FolderTarget[];
  allFolders(): readonly string[];
  createInbox(path: string): Promise<void>;
  previewAnalysis(paths?: readonly string[]): BatchAnalysisPreview;
  analyzeInbox(paths: readonly string[]): void;
  readPreview(path: string): Promise<{ text: string; truncated: boolean }>;
  createDestination(path: string): Promise<FolderTarget>;
  analyzeNote(path: string): void;
  ignoreNote(path: string): void;
  restoreIgnored(): void;
  prepareMove(path: string, target: string): Promise<MovePlan>;
  confirmMove(plan: MovePlan): Promise<void>;
  undoMove(id: string): Promise<void>;
  recentMoves(): readonly MoveRecord[];
  acknowledgeMove(id: string): Promise<void>;
  findLinks(): Promise<void>;
  prepareLink(proposal: LinkProposal, target: number): LinkPlan;
  confirmLink(plan: LinkPlan): void;
  confirmLinks(plans: readonly LinkPlan[]): LinkConfirmation;
  dismissLink(proposal: LinkProposal): void;
  openNote(path: string): void;
  scanLinks(sessionId: string, ranges: readonly TextRange[]): readonly LinkMention[];
  verifyLink(sessionId: string, mention: LinkMention): Promise<number | null>;
  linkProposalFor(sessionId: string, mention: LinkMention, targetId?: number): LinkProposal;
  ignoreLinkTerm(term: string): Promise<void>;
  searchLinkTargets(query: string, sourcePath: string): readonly TargetMatch[];
  verifyLinkQuery(sourcePath: string, match: string, line: string, candidates: readonly LinkTarget[], isCurrent: () => boolean): Promise<number | null>;
  linkMarkdown(target: LinkTarget, sourcePath: string, alias?: string): string;
  nextInboxNote(exclude?: string): string | null;
  attachmentCount(path: string): number;
  target(id: number): LinkTarget | undefined;
}
