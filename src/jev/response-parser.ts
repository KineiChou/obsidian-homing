import { OrganizerError } from '../core/errors';
import { serializeBatch } from './request';
import type { ChoiceAnswer, ChoiceBatch, ChoiceBatchResult } from './types';

const ROUNDING_RADIUS = 0.005;
const FLOAT_TOLERANCE = 1e-9;

function invalid(): never { throw new OrganizerError('invalid-response', 'error.responseInvalid'); }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function probability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid();
  return value;
}
export function parseChoiceResponse(value: unknown, batch: ChoiceBatch): ChoiceBatchResult {
  serializeBatch(batch);
  const response = record(value);
  if (typeof response.model !== 'string' || !/^jev-[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(response.model)) invalid();
  if (batch.modelId !== 'jev-latest' && response.model !== batch.modelId) invalid();
  // Aliases must resolve before dependent requests can pin a concrete model.
  if (response.model === 'jev-latest') invalid();
  const source = record(response.answers);
  if (Object.keys(source).length !== batch.questions.length) invalid();
  const answers: Record<string, ChoiceAnswer> = Object.create(null) as Record<string, ChoiceAnswer>;
  for (const question of batch.questions) {
    if (!Object.hasOwn(source, question.id)) invalid();
    const answer = record(source[question.id]);
    if (answer.type !== 'choice' || typeof answer.choice !== 'string') invalid();
    const options = question.options.map(option => option.id);
    if (!options.includes(answer.choice)) invalid();
    const raw = record(answer.probabilities);
    if (Object.keys(raw).length !== options.length) invalid();
    const probabilities: Record<string, number> = Object.create(null) as Record<string, number>;
    let sum = 0;
    let lowerTotal = 0;
    let upperTotal = 0;
    for (const option of options) {
      if (!Object.hasOwn(raw, option)) invalid();
      const value = probability(raw[option]);
      probabilities[option] = value;
      sum += value;
      // Jev rounds individual probabilities to hundredths; their sum can be 0.99 or 1.01.
      lowerTotal += Math.max(0, value - ROUNDING_RADIUS);
      upperTotal += Math.min(1, value + ROUNDING_RADIUS);
    }
    if (sum <= 0 || lowerTotal > 1 + FLOAT_TOLERANCE || upperTotal < 1 - FLOAT_TOLERANCE) invalid();
    const chosen = probabilities[answer.choice]!;
    if (Object.values(probabilities).some(value => value > chosen + 0.000001)) invalid();
    for (const option of options) probabilities[option] = probabilities[option]! / sum;
    answers[question.id] = { selected: answer.choice, probabilities, confidence: probability(answer.confidence) };
  }
  let inputTokens: number | null = null;
  if (response.usage !== undefined && response.usage !== null) {
    const usage = record(response.usage);
    if (usage.input_tokens !== undefined && usage.input_tokens !== null) {
      if (typeof usage.input_tokens !== 'number' || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0) invalid();
      inputTokens = usage.input_tokens;
    }
  }
  return { modelId: response.model, answers, inputTokens };
}
