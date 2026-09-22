import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseChoiceResponse } from '../src/jev/response-parser';
import { JevClient } from '../src/jev/client';
import { SharedDecisionScheduler } from '../src/jev/scheduler';
import { MixedDepthClassifier } from '../src/filing/classifier';
import { JevLinkRecommender } from '../src/linking/recommender';
import { serializeBatch } from '../src/jev/request';
import { OrganizerError } from '../src/core/errors';
import type { DecisionScheduler, ChoiceBatch, ChoiceBatchResult } from '../src/jev/types';
import { answer, batch, context, deferred, note, scope, target, usage } from './helpers';

function raw() { return { model: context.modelId, answers: { pick: { type: 'choice', choice: 'yes', confidence: .7, probabilities: { yes: .7, no: .3 } } }, usage: { input_tokens: 17 } }; }
function immediate(evaluate = vi.fn(async (request: ChoiceBatch) => answer(request))): DecisionScheduler { return { evaluate, cancel: vi.fn(), setPaused: vi.fn(), status: () => ({ pending: 0, inFlight: false, paused: false, reason: null }), subscribe: () => () => undefined, dispose: vi.fn() }; }
afterEach(() => vi.useRealTimers());

describe('Jev boundary', () => {
  it('translates Choice responses and distinguishes unknown token usage', () => { expect(parseChoiceResponse(raw(), batch).inputTokens).toBe(17); const value = raw(); delete (value as { usage?: unknown }).usage; expect(parseChoiceResponse(value, batch).inputTokens).toBeNull(); });
  it.each(['model', 'choice', 'probability', 'missing', 'confidence', 'usage'] as const)('rejects malformed %s', field => {
    const value = raw();
    if (field === 'model') value.model = 'jev-1.12.0';
    if (field === 'choice') value.answers.pick.choice = 'outside';
    if (field === 'probability') value.answers.pick.probabilities.yes = Infinity;
    if (field === 'missing') delete (value.answers.pick.probabilities as { no?: number }).no;
    if (field === 'confidence') value.answers.pick.confidence = -1;
    if (field === 'usage') value.usage.input_tokens = -1;
    expect(() => parseChoiceResponse(value, batch)).toThrow();
  });
  it('rejects 256 choices and oversized state before transport', () => {
    expect(() => serializeBatch({ ...batch, questions: [{ ...batch.questions[0]!, options: Array.from({ length: 256 }, (_, id) => ({ id: String(id), description: '' })) }] })).toThrow();
    expect(() => serializeBatch({ ...batch, state: '密'.repeat(11000) })).toThrow();
  });
  it('uses exact endpoint and bearer credential; no raw failure payload leaks', async () => {
    const post = vi.fn(async (_url: string, _headers: Readonly<Record<string, string>>, _body: string) => ({ status: 401, headers: {}, json: { error: 'private note text' } }));
    const client = new JevClient({ post }, { get: () => 'credential' });
    await expect(client.evaluate(batch)).rejects.toMatchObject({ code: 'authentication' });
    expect(post.mock.calls[0]?.[0]).toBe('https://api.typesafe.ai/v1/systemone');
  });
});

describe('physical request scheduling', () => {
  it('retains the actual slot after logical timeout', async () => {
    vi.useFakeTimers(); const first = deferred<ChoiceBatchResult>(); const client = { evaluate: vi.fn().mockReturnValueOnce(first.promise).mockImplementation(async (request: ChoiceBatch) => answer(request)) };
    const scheduler = new SharedDecisionScheduler(client, usage(), () => 100, { logicalTimeoutMs: 100, maxRetries: 0 });
    const timed = scheduler.evaluate(batch, scope('first')).catch(error => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await timed).toMatchObject({ code: 'timeout' }); expect(scheduler.status().inFlight).toBe(true);
    const next = scheduler.evaluate(batch, scope('next')); await Promise.resolve(); expect(client.evaluate).toHaveBeenCalledTimes(1);
    first.resolve(answer(batch)); await next; expect(client.evaluate).toHaveBeenCalledTimes(2); scheduler.dispose();
  });
  it('supersedes active results without overlapping physical requests', async () => {
    const first = deferred<ChoiceBatchResult>(); const client = { evaluate: vi.fn().mockReturnValueOnce(first.promise).mockImplementation(async (request: ChoiceBatch) => answer(request)) };
    const scheduler = new SharedDecisionScheduler(client, usage(), () => 100);
    const old = scheduler.evaluate(batch, scope('same')).catch(error => error); await Promise.resolve(); await Promise.resolve();
    const next = scheduler.evaluate(batch, scope('same')); expect(await old).toMatchObject({ code: 'cancelled' }); expect(client.evaluate).toHaveBeenCalledTimes(1);
    first.resolve(answer(batch)); await next; scheduler.dispose();
  });
  it('respects automatic spacing and rejects exhausted quota without transport', async () => {
    vi.useFakeTimers(); const client = { evaluate: vi.fn(async () => answer(batch)) }; const quota = usage(); const scheduler = new SharedDecisionScheduler(client, quota, () => 100);
    await scheduler.evaluate(batch, scope('one', true)); const second = scheduler.evaluate(batch, scope('two', true));
    await vi.advanceTimersByTimeAsync(4999); expect(client.evaluate).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(1); await second;
    vi.mocked(quota.reserve).mockRejectedValueOnce(new OrganizerError('budget', 'full'));
    await expect(scheduler.evaluate(batch, scope('manual'))).rejects.toMatchObject({ code: 'budget' }); expect(client.evaluate).toHaveBeenCalledTimes(2); scheduler.dispose();
  });
  it('closes an unknown reservation when cancelled before sending', async () => {
    const reservation = deferred<void>(); const quota = usage(); vi.mocked(quota.reserve).mockReturnValueOnce(reservation.promise);
    const client = { evaluate: vi.fn(async () => answer(batch)) }; const scheduler = new SharedDecisionScheduler(client, quota, () => 100);
    const cancelled = scheduler.evaluate(batch, scope()).catch(error => error); scheduler.cancel('task'); reservation.resolve(); await cancelled;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(quota.settle).toHaveBeenCalledWith(null); expect(client.evaluate).not.toHaveBeenCalled(); scheduler.dispose();
  });
  it('pauses all queued work on authentication failure', async () => {
    const result = deferred<ChoiceBatchResult>(); const scheduler = new SharedDecisionScheduler({ evaluate: () => result.promise }, usage(), () => 100);
    const first = scheduler.evaluate(batch, scope('first')).catch(error => error); await Promise.resolve();
    const next = scheduler.evaluate(batch, scope('next')).catch(error => error); result.reject(new OrganizerError('authentication', 'update key'));
    expect(await first).toMatchObject({ code: 'authentication' }); expect(await next).toMatchObject({ code: 'authentication' }); expect(scheduler.status().paused).toBe(true); scheduler.dispose();
  });
});

describe('classification and linking decisions', () => {
  it('compares mixed-depth destinations directly when they fit', async () => {
    const scheduler = immediate(); const classifier = new MixedDepthClassifier(scheduler);
    const proposal = await classifier.propose(note, { revision: 1, targets: [{ id: 'a', path: 'Resources', directPurpose: '', effectiveRules: [] }, { id: 'b', path: 'Projects/Deep/Experiment', directPurpose: '', effectiveRules: [] }] }, context, scope());
    expect(proposal.selected).toBe('a'); expect(scheduler.evaluate).toHaveBeenCalledTimes(1);
  });
  it('includes every group despite unassigned winning and reranks finalists together', async () => {
    const seen: ChoiceBatch[] = []; const evaluate = vi.fn(async (request: ChoiceBatch) => { seen.push(request); return answer(request, (ids, question) => question.startsWith('group') ? 'unassigned' : ids[0]!); });
    const classifier = new MixedDepthClassifier(immediate(evaluate));
    const targets = Array.from({ length: 600 }, (_, i) => ({ id: 'f' + i, path: 'Folder' + i, directPurpose: '', effectiveRules: [] }));
    await classifier.propose(note, { revision: 1, targets }, context, scope());
    const groups = seen.flatMap(request => request.questions).filter(question => question.id.startsWith('group'));
    expect(groups).toHaveLength(10); expect(new Set(groups.flatMap(question => question.options.filter(option => option.id !== 'unassigned').map(option => option.id))).size).toBe(600);
    expect(seen.at(-1)?.questions[0]?.options).toHaveLength(31);
  });
  it('aborts between groups and final decision when snapshot changes', async () => {
    let current = true; const scheduler = immediate(vi.fn(async request => { current = false; return answer(request); }));
    const targets = Array.from({ length: 300 }, (_, i) => ({ id: 'f' + i, path: 'Folder' + i, directPurpose: '', effectiveRules: [] }));
    await expect(new MixedDepthClassifier(scheduler).propose(note, { revision: 1, targets }, context, { ...scope(), isCurrent: () => current })).rejects.toMatchObject({ code: 'stale' });
    expect(scheduler.evaluate).toHaveBeenCalledTimes(1);
  });
  it('caches identical link decisions and invalidates changed targets', async () => {
    const scheduler = immediate(); const service = new JevLinkRecommender(scheduler);
    const input = { anchor: { editorSessionId: 's', noteId: 2, sourcePath: 'Inbox/source.md', documentRevision: 0, from: 0, to: 11, originalText: 'Transformer', contextFrom: 0, contextText: 'Transformer' }, catalogueEpoch: 1, candidates: [target()] };
    await service.propose([input], context, scope()); await service.propose([input], context, scope()); expect(scheduler.evaluate).toHaveBeenCalledTimes(1);
    await service.propose([{ ...input, candidates: [target(1, 'Transformer', { revision: 2 })] }], context, scope()); expect(scheduler.evaluate).toHaveBeenCalledTimes(2);
  });
});
