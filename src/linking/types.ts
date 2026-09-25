import type { OrganizerError } from '../core/errors';
import type { DecisionContext, RequestScope } from '../jev/types';
export interface LinkTarget { readonly noteId: number; readonly path: string; readonly title: string; readonly aliases: readonly string[]; readonly tags: readonly string[]; readonly description: string; readonly revision: number }
/** How a matched term relates to its note (docs/link-matching.md §2). */
export type TermKind = 'title' | 'alias' | 'inflection' | 'derived';
export interface Match { readonly from: number; readonly to: number; readonly text: string; readonly noteIds: readonly number[]; readonly kinds: Readonly<Record<number, TermKind>> }
export interface MatchResult { readonly matches: readonly Match[]; readonly limited: boolean }
export interface MetadataIndex {
  readonly epoch: number;
  readonly size: number;
  upsert(target: LinkTarget): void;
  remove(noteId: number): void;
  get(noteId: number): LinkTarget | undefined;
  match(text: string, offset?: number): MatchResult;
  /** Indexed notes with their normalized terms, for explicit `[[?` searches. */
  documents(): Iterable<{ readonly target: LinkTarget; readonly terms: ReadonlyMap<string, TermKind> }>;
  clear(): void;
}
/** Link statistics from resolved metadata only; no note bodies (§4). */
export interface LinkGraph {
  replaceSource(sourceId: number, links: readonly { readonly targetId: number; readonly anchor: string }[]): void;
  removeNote(noteId: number): void;
  anchorCounts(anchor: string): ReadonlyMap<number, number>;
  relatedness(sourceId: number, targetId: number): number;
  clear(): void;
}
export type MentionTier = 'confident' | 'uncertain';
export interface RankedCandidate { readonly target: LinkTarget; readonly kind: TermKind; readonly score: number; readonly commonness: number; readonly related: number }
/** A locally found mention with absolute document offsets. */
export interface LocalMention { readonly from: number; readonly to: number; readonly text: string; readonly tier: MentionTier; readonly candidates: readonly RankedCandidate[] }
export interface ScanRequest {
  readonly sourceNoteId: number;
  readonly sourcePath: string;
  readonly text: string;
  readonly offset: number;
  readonly allowedRanges: readonly TextRange[];
  readonly linkedNoteIds: ReadonlySet<number>;
  readonly ignoredTerms: ReadonlySet<string>;
  allowed(target: LinkTarget): boolean;
}
export interface TextAnchor { readonly editorSessionId: string; readonly noteId: number; readonly sourcePath: string; readonly documentRevision: number; readonly from: number; readonly to: number; readonly originalText: string; readonly contextFrom: number; readonly contextText: string }
export interface LinkInput { readonly anchor: TextAnchor; readonly catalogueEpoch: number; readonly candidates: readonly LinkTarget[] }
export interface LinkProposal { readonly id: string; readonly input: LinkInput; readonly context: DecisionContext; readonly selected: number | null }
export interface LinkRecommender { propose(inputs: readonly LinkInput[], context: DecisionContext, scope: RequestScope): Promise<readonly LinkProposal[]> }
export interface TextRange { readonly from: number; readonly to: number }
export interface EditorSnapshot {
  readonly sessionId: string;
  readonly noteId: number;
  readonly path: string;
  readonly revision: number;
  readonly contextFrom: number;
  readonly text: string;
  readonly allowedRanges: readonly TextRange[];
  readonly dirtyRanges?: readonly TextRange[];
  readonly linkedNoteIds: ReadonlySet<number>;
}
export interface MentionMatcher { inputs(snapshot: EditorSnapshot, allowed: (target: LinkTarget) => boolean): readonly LinkInput[] }
export interface LinkPlan { readonly id: string; readonly proposalId: string; readonly anchor: TextAnchor; readonly target: LinkTarget; readonly replacement: string; readonly catalogueEpoch: number; readonly settingsRevision: number }
export interface EditorChange { readonly dirtyRanges: readonly TextRange[]; mapAnchor(anchor: TextAnchor): TextAnchor | null }
export interface LinkInsertion { readonly anchor: TextAnchor; readonly replacement: string; readonly target: number }
export interface LinkConfirmation { readonly appliedPlanIds: readonly string[]; readonly failures: readonly { planId: string; error: OrganizerError }[] }
export interface EditorPort {
  snapshot(): EditorSnapshot | null;
  read(from: number, to: number): string;
  allows(from: number, to: number): boolean;
  replace(from: number, to: number, replacement: string): void;
  replaceMany(changes: readonly { from: number; to: number; replacement: string }[]): void;
  rememberInsertions?(insertions: readonly LinkInsertion[]): void;
  suppress(anchor: TextAnchor, targetId: number | null): void;
}
export interface LinkHost {
  editor(sessionId: string): EditorPort | undefined;
  generateLink(target: LinkTarget, sourcePath: string, alias: string): string;
  resolvesTo(link: string, sourcePath: string, target: LinkTarget): boolean;
  allowed(target: LinkTarget): boolean;
  settingsRevision(): number;
}
export interface LinkService {
  prepare(proposal: LinkProposal, targetId: number): LinkPlan;
  confirm(planId: string): void;
  confirmMany(planIds: readonly string[]): LinkConfirmation;
}
