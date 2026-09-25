import { describe, expect, it, vi } from 'vitest';
import { createDecisionClient, parseStructuredResponse } from '../src/providers/client';
import { SharedDecisionScheduler } from '../src/jev/scheduler';
import { MixedDepthClassifier } from '../src/filing/classifier';
import { closeAlternatives } from '../src/filing/alternatives';
import { PluginStateStore } from '../src/storage/state-store';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { FilingProposal } from '../src/filing/types';
import type { ChoiceBatch, HttpResponse, HttpTransport } from '../src/jev/types';
import { context, memoryPort, note, scope, usage } from './helpers';

const batch: ChoiceBatch = { modelId: 'demo-model', state: 'Synthetic example', questions: [{ id: 'pick', instructions: 'Choose.', options: [{ id: 'a', description: 'A' }, { id: 'b', description: 'B' }, { id: 'unassigned', description: 'None' }] }] };
const parse = (answer: unknown) => parseStructuredResponse(JSON.stringify({ answers: { pick: answer } }), batch, null).answers.pick!;
const completion = (answer: unknown): HttpResponse => ({ status: 200, headers: {}, json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: { pick: answer } }) } }] } });
const body = (post: ReturnType<typeof vi.fn<HttpTransport['post']>>, call: number) => JSON.parse(post.mock.calls[call]![2]) as Record<string, unknown>;

describe('structured answers', () => {
  it('normalizes percentages into probabilities with the choice as confidence', () => {
    const answer = parse({ choice: 'a', probabilities: { a: 70, b: 25, unassigned: 5 } });
    expect(answer).toMatchObject({ selected: 'a', rankOnly: false });
    expect(answer.probabilities.a).toBeCloseTo(.7); expect(answer.probabilities.b).toBeCloseTo(.25); expect(answer.confidence).toBeCloseTo(.7);
  });
  it('accepts a 0–1 scale and small rounding drift', () => {
    expect(parse({ choice: 'b', probabilities: { a: .2, b: .75, unassigned: .04 } }).probabilities.b).toBeCloseTo(.75 / .99);
    expect(parse({ choice: 'a', probabilities: { a: 60, b: 30, unassigned: 13 } })).toMatchObject({ rankOnly: false });
  });
  it.each([
    ['percentages far from 100', { choice: 'a', probabilities: { a: 90, b: 80, unassigned: 10 } }, ['a', 'b', 'unassigned']],
    ['a choice that is not the most likely option', { choice: 'b', probabilities: { a: 60, b: 30, unassigned: 10 } }, ['b', 'a', 'unassigned']],
    ['a legacy ranking', { choice: 'b', ranking: ['b', 'unassigned', 'a'] }, ['b', 'unassigned', 'a']],
    ['a bare choice', { choice: 'b' }, ['b', 'a', 'unassigned']],
  ])('keeps only the order for %s', (_label, answer, order) => {
    const result = parse(answer);
    expect(result).toMatchObject({ selected: order[0], rankOnly: true, confidence: 0 });
    expect(Object.entries(result.probabilities).sort((x, y) => y[1] - x[1]).map(([id]) => id)).toEqual(order);
  });
  it.each([
    { choice: 'outside', probabilities: { a: 50, b: 50, unassigned: 0 } },
    { choice: 'a', probabilities: { a: 50, b: 50 } },
    { choice: 'a', probabilities: { a: 50, b: 50, unassigned: 0, extra: 0 } },
    { choice: 'a', probabilities: { a: -5, b: 50, unassigned: 55 } },
    { choice: 'a', probabilities: { a: 150, b: 0, unassigned: 0 } },
    { choice: 'a', probabilities: { a: '70', b: 20, unassigned: 10 } },
    { choice: 'a', probabilities: { a: 0, b: 0, unassigned: 0 } },
    { choice: 'a', ranking: ['b', 'a', 'unassigned'] },
  ])('rejects malformed fields %j', answer => {
    expect(() => parse(answer)).toThrow();
  });
  it('reads JSON wrapped in a code fence or surrounding text', () => {
    const json = JSON.stringify({ answers: { pick: { choice: 'a', probabilities: { a: 80, b: 15, unassigned: 5 } } } });
    for (const text of ['```json\n' + json + '\n```', 'Here you go: ' + json]) expect(parseStructuredResponse(text, batch, 3)).toMatchObject({ inputTokens: 3, answers: { pick: { selected: 'a', rankOnly: false } } });
  });
});

describe('structured output with a compatible fallback', () => {
  it('sends probability schemas to OpenAI-style providers and output_config to Anthropic', async () => {
    const post = vi.fn<HttpTransport['post']>(async () => completion({ choice: 'a', probabilities: { a: 80, b: 15, unassigned: 5 } }));
    await createDecisionClient({ post }, { get: () => 'synthetic-key' }, () => ({ provider: 'openai-compatible', endpoint: 'https://example.com/v1' })).evaluate(batch);
    expect(body(post, 0).response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'choice_probabilities', strict: true } });
    const anthropic = vi.fn<HttpTransport['post']>(async () => ({ status: 200, headers: {}, json: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ answers: { pick: { choice: 'a', probabilities: { a: 80, b: 15, unassigned: 5 } } } }) }] } }));
    const result = await createDecisionClient({ post: anthropic }, { get: () => 'synthetic-key' }, () => ({ provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1' })).evaluate(batch);
    expect(result.answers.pick).toMatchObject({ selected: 'a', rankOnly: false });
    expect(body(anthropic, 0)).toMatchObject({ max_tokens: 16000, output_config: { format: { type: 'json_schema', schema: { required: ['answers'] } } } });
  });
  it('retries a rejected structured request once in compatible mode and keeps later batches structured', async () => {
    const post = vi.fn<HttpTransport['post']>().mockResolvedValueOnce({ status: 400, headers: {}, json: { error: 'unsupported response_format' } }).mockResolvedValue(completion({ choice: 'b', ranking: ['b', 'a', 'unassigned'] }));
    const client = createDecisionClient({ post }, { get: () => null }, () => ({ provider: 'ollama', endpoint: 'http://127.0.0.1:11579/v1' }));
    await expect(client.evaluate(batch)).rejects.toMatchObject({ code: 'format' });
    expect((await client.evaluate(batch)).answers.pick).toMatchObject({ selected: 'b', rankOnly: true });
    expect(body(post, 1).response_format).toEqual({ type: 'json_object' });
    await client.evaluate({ ...batch });
    expect(body(post, 2).response_format).toMatchObject({ type: 'json_schema' });
  });
  it('stays in compatible mode after two consecutive rejections for the same configuration', async () => {
    const post = vi.fn<HttpTransport['post']>(async (_url, _headers, request) => JSON.parse(request).output_config ? { status: 400, headers: {}, json: {} } : { status: 200, headers: {}, json: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ answers: { pick: { choice: 'a' } } }) }] } });
    const client = createDecisionClient({ post }, { get: () => 'synthetic-key' }, () => ({ provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1' }));
    for (let i = 0; i < 2; i++) await expect(client.evaluate({ ...batch })).rejects.toMatchObject({ code: 'format' });
    expect((await client.evaluate({ ...batch })).answers.pick).toMatchObject({ selected: 'a', rankOnly: true });
    expect(post).toHaveBeenCalledTimes(3); expect(body(post, 2)).not.toHaveProperty('output_config');
  });
  it('does not retry truncated or refused output', async () => {
    const post = vi.fn<HttpTransport['post']>(async () => ({ status: 200, headers: {}, json: { choices: [{ finish_reason: 'length', message: { content: '{"answers":' } }] } }));
    await expect(createDecisionClient({ post }, { get: () => null }, () => ({ provider: 'ollama', endpoint: 'http://127.0.0.1:11579/v1' })).evaluate(batch)).rejects.toMatchObject({ code: 'invalid-response' });
  });
  it('lets the scheduler retry once and counts both requests against the daily allowance', async () => {
    vi.useFakeTimers();
    const post = vi.fn<HttpTransport['post']>().mockResolvedValueOnce(completion({ choice: 'a', probabilities: 'high' })).mockResolvedValueOnce(completion({ choice: 'a', probabilities: { a: 70, b: 20, unassigned: 10 } }));
    const quota = usage();
    const scheduler = new SharedDecisionScheduler(createDecisionClient({ post }, { get: () => null }, () => ({ provider: 'ollama', endpoint: 'http://127.0.0.1:11579/v1' })), quota, () => 100);
    const pending = scheduler.evaluate(batch, scope('retry'));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).answers.pick).toMatchObject({ selected: 'a', rankOnly: false });
    expect(quota.reserve).toHaveBeenCalledTimes(2); expect(quota.settle).toHaveBeenCalledTimes(2);
    expect(body(post, 1).response_format).toEqual({ type: 'json_object' });
    scheduler.dispose(); vi.useRealTimers();
  });
});

describe('ranking-only proposals', () => {
  const proposal = (rankOnly?: boolean): FilingProposal => ({ id: 'p', source: note.source, foldersRevision: 1, context, selected: 'a', ranked: [{ targetId: 'a', probability: .5 }, { targetId: 'b', probability: .4 }], ...(rankOnly === undefined ? {} : { rankOnly }) });
  it('never reports close alternatives without real probabilities', () => {
    expect(closeAlternatives(proposal()).map(item => item.targetId)).toEqual(['b']);
    expect(closeAlternatives(proposal(true))).toEqual([]);
  });
  it('carries the flag from the final answer into the filing proposal', async () => {
    const evaluate = vi.fn(async (request: ChoiceBatch) => ({ modelId: request.modelId, inputTokens: null, answers: { destination: { selected: 'a', probabilities: { a: .5, b: .33, unassigned: .17 }, confidence: 0, rankOnly: true } } }));
    const scheduler = { evaluate, cancel() {}, setPaused() {}, status: () => ({ pending: 0, inFlight: false, paused: false, reason: null }), subscribe: () => () => undefined, dispose() {} };
    const targets = ['a', 'b'].map(id => ({ id, path: id.toUpperCase(), directPurpose: '', effectiveRules: [] }));
    expect(await new MixedDepthClassifier(scheduler).propose(note, { revision: 1, targets }, context, scope())).toMatchObject({ selected: 'a', rankOnly: true });
  });
  it('marks saved non-Jev suggestions from earlier versions as ranking-only', async () => {
    const saved = (modelId: string, extra: object = {}) => ({ path: `Inbox/${modelId.replace(/[^a-z0-9-]/gi, '-')}.md`, status: 'pending', proposal: { contentHash: 'h', selectedPath: 'A', ranked: [{ path: 'A', probability: .5 }, { path: 'B', probability: .33 }], modelId, promptRevision: 1, settingsFingerprint: 'f', createdAt: 1, ...extra } });
    const port = memoryPort({ schemaVersion: 2, settings: DEFAULT_SETTINGS, filingQueue: [saved('jev-1.13.0'), saved('qwen3:1.7b'), saved('gpt-4.1-mini', { rankOnly: false })], moveJournal: [] });
    const store = new PluginStateStore(port.port); await store.load();
    expect(store.snapshot().filingQueue.map(entry => entry.proposal?.rankOnly)).toEqual([false, true, false]);
  });
});
