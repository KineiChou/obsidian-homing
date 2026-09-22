import type { Unsubscribe } from '../core/events';
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface ChoiceQuestion { readonly id: string; readonly instructions: string; readonly options: readonly { readonly id: string; readonly description: JsonValue }[] }
export interface ChoiceBatch { readonly modelId: string; readonly state: JsonValue; readonly questions: readonly ChoiceQuestion[] }
export interface ChoiceAnswer { readonly selected: string; readonly probabilities: Readonly<Record<string, number>>; readonly confidence: number }
export interface ChoiceBatchResult { readonly modelId: string; readonly answers: Readonly<Record<string, ChoiceAnswer>>; readonly inputTokens: number | null }
export interface DecisionClient { evaluate(batch: ChoiceBatch): Promise<ChoiceBatchResult> }
export interface HttpResponse { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly json: unknown }
export interface HttpTransport { post(url: string, headers: Readonly<Record<string, string>>, body: string): Promise<HttpResponse> }
export interface SecretProvider { get(): string | null }
export interface DecisionContext { readonly taskId: string; readonly settingsRevision: number; readonly promptRevision: number; readonly modelId: string }
export interface RequestScope { readonly key: string; readonly priority: 'manual' | 'link' | 'filing'; readonly automatic: boolean; isCurrent(): boolean }
export interface DailyUsage { readonly day: string; readonly requests: number; readonly inputTokens: number; readonly unknownRequests: number }
export interface UsageStore {
  read(): DailyUsage;
  reserve(limit: number): Promise<void>;
  settle(inputTokens: number | null): Promise<void>;
}
export interface SchedulerStatus { readonly pending: number; readonly inFlight: boolean; readonly paused: boolean; readonly reason: string | null }
export interface DecisionScheduler {
  evaluate(batch: ChoiceBatch, scope: RequestScope): Promise<ChoiceBatchResult>;
  cancel(key: string): void;
  setPaused(paused: boolean): void;
  status(): SchedulerStatus;
  subscribe(listener: () => void): Unsubscribe;
  dispose(): void;
}
export interface SchedulerOptions { readonly minAutomaticIntervalMs?: number; readonly logicalTimeoutMs?: number; readonly maxRetries?: number; readonly maxPending?: number }
