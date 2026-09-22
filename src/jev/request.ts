import { OrganizerError } from '../core/errors';
import type { ChoiceBatch, ChoiceQuestion, JsonValue, RequestScope } from './types';

// UTF-8 bytes deliberately overestimate token count; reserve space for service framing.
const QUESTION_BUDGET = 30_000;
const REQUEST_BUDGET = 60_000;
export const UNASSIGNED = 'unassigned';

export function assertCurrent(scope: RequestScope): void {
  if (!scope.isCurrent()) throw new OrganizerError('stale', '内容或设置已改变，请重新分析。');
}
export function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
function assertIds(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length || ids.some(id => !id || id.length > 200)) {
    throw new OrganizerError('invalid-settings', '问题或候选标识无效。');
  }
}
export function serializeQuestion(question: ChoiceQuestion): JsonValue {
  if (question.options.length < 2 || question.options.length > 255) {
    throw new OrganizerError('limit', '每题需要 2 至 255 个选项，请缩小候选范围。');
  }
  assertIds(question.options.map(option => option.id));
  return { type: 'choice', instructions: question.instructions, criteria: Object.fromEntries(question.options.map(option => [option.id, option.description])) };
}
export function serializeBatch(batch: ChoiceBatch): string {
  if (!batch.modelId.trim() || batch.modelId.length > 200 || batch.questions.length === 0 || batch.questions.length > 256) {
    throw new OrganizerError('invalid-settings', '模型或问题配置无效。');
  }
  assertIds(batch.questions.map(question => question.id));
  const questions = Object.fromEntries(batch.questions.map(question => [question.id, serializeQuestion(question)]));
  const stateSize = byteLength(batch.state);
  if (Object.values(questions).some(question => stateSize + byteLength(question) > QUESTION_BUDGET)) {
    throw new OrganizerError('limit', '笔记与候选说明超过单题发送预算，请缩小范围或手动处理。');
  }
  const value = { model: batch.modelId, state: batch.state, questions };
  if (byteLength(value) > REQUEST_BUDGET) throw new OrganizerError('limit', '本次分析超过发送预算，请缩小范围或手动处理。');
  return JSON.stringify(value);
}
export function fitsBatch(batch: ChoiceBatch): boolean {
  try { serializeBatch(batch); return true; }
  catch (error) { if (error instanceof OrganizerError && error.code === 'limit') return false; throw error; }
}
export function packQuestions(modelId: string, state: JsonValue, questions: readonly ChoiceQuestion[]): ChoiceBatch[] {
  const batches: ChoiceBatch[] = [];
  let current: ChoiceQuestion[] = [];
  for (const question of questions) {
    const next = { modelId, state, questions: [...current, question] };
    if (fitsBatch(next)) { current.push(question); continue; }
    if (current.length) batches.push({ modelId, state, questions: current });
    serializeBatch({ modelId, state, questions: [question] });
    current = [question];
  }
  if (current.length) batches.push({ modelId, state, questions: current });
  return batches;
}
