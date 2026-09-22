import { vi } from 'vitest';
import type { ChoiceBatch, ChoiceBatchResult, DecisionContext, RequestScope, UsageStore } from '../src/jev/types';
import type { LinkTarget } from '../src/linking/types';
import type { NoteSnapshot } from '../src/filing/types';
import type { PersistedState, PersistencePort } from '../src/storage/types';

export const context: DecisionContext = { taskId: 'task', settingsRevision: 0, promptRevision: 1, modelId: 'jev-1.13.0' };
export const scope = (key = 'task', automatic = false): RequestScope => ({ key, priority: automatic ? 'filing' : 'manual', automatic, isCurrent: () => true });
export const batch: ChoiceBatch = { modelId: context.modelId, state: 'Example', questions: [{ id: 'pick', instructions: 'Choose.', options: [{ id: 'yes', description: 'Yes' }, { id: 'no', description: 'No' }] }] };
export function answer(request: ChoiceBatch, choose: (ids: string[], question: string) => string = ids => ids[0]!): ChoiceBatchResult {
  return { modelId: request.modelId, inputTokens: 12, answers: Object.fromEntries(request.questions.map(question => {
    const selected = choose(question.options.map(option => option.id), question.id);
    return [question.id, { selected, confidence: 1, probabilities: Object.fromEntries(question.options.map(option => [option.id, option.id === selected ? 1 : 0])) }];
  })) };
}
export function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export function usage(): UsageStore { return { read: () => ({ day: '2026-09-22', requests: 0, inputTokens: 0, unknownRequests: 0 }), reserve: vi.fn(async () => undefined), settle: vi.fn(async () => undefined) }; }
export function target(noteId = 1, title = 'Transformer', extra: Partial<LinkTarget> = {}): LinkTarget { return { noteId, path: `Resources/${title}.md`, title, aliases: [], tags: [], description: '', revision: 1, ...extra }; }
export const note: NoteSnapshot = { source: { noteId: 10, path: 'Inbox/笔记.md', revision: 1, contentHash: 'hash' }, title: '笔记', body: 'Transformer 阅读笔记', tags: [] };
export function memoryPort(initial: unknown = null) {
  let data = initial;
  const local = new Map<string, unknown>();
  const port: PersistencePort = { load: async () => data, save: vi.fn(async (next: PersistedState) => { data = structuredClone(next); }), loadLocal: key => local.get(key), saveLocal: (key, value) => { local.set(key, structuredClone(value)); } };
  return { port, local, data: () => data };
}
