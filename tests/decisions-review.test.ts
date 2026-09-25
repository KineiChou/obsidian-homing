import { describe, expect, it, vi } from 'vitest';
import { prepareNote } from '../src/filing/note-excerpt';
import { MixedDepthClassifier } from '../src/filing/classifier';
import { MemoryFolderProfiles } from '../src/folders/profiles';
import { createDecisionClient, parseStructuredResponse } from '../src/providers/client';
import { DEFAULT_SETTINGS, parseSettings } from '../src/settings';
import { byteLength } from '../src/jev/request';
import type { ChoiceBatch, DecisionScheduler, HttpTransport } from '../src/jev/types';
import { answer, batch, context, note, scope } from './helpers';
function scheduler() { const requests: ChoiceBatch[] = []; const value: DecisionScheduler = { evaluate: vi.fn(async request => { requests.push(request); return answer(request); }), cancel() {}, setPaused() {}, status: () => ({ pending: 0, inFlight: false, paused: false, reason: null }), subscribe: () => () => undefined, dispose() {} }; return { value, requests }; }
const ranked = JSON.stringify({ answers: { pick: { choice: 'yes', ranking: ['yes', 'no'] } } });

describe('long note excerpts', () => {
  it('fits 30,000 Chinese characters and preserves headings, section opening and Unicode', async () => {
    const input = { ...note, body: '# 总览\n\n' + '学习😀'.repeat(10000) + '\n## 稀有主题\n量子计算与纠错\n' };
    const prepared = prepareNote(input);
    expect(prepared.excerpt?.originalChars).toBe(Array.from(input.body).length);
    expect(prepared.note.body).toContain('## 稀有主题'); expect(prepared.note.body).toContain('量子计算与纠错');
    expect(byteLength(prepared.note.body)).toBeLessThanOrEqual(12000);
    expect(prepareNote(prepared.note)).toEqual(prepared);
    expect(prepared.note.body).not.toMatch(/[\uD800-\uDBFF]$/);
    const { value, requests } = scheduler();
    const result = await new MixedDepthClassifier(value).propose(input, { revision: 1, targets: [{ id: 'a', path: '研究', directPurpose: '', effectiveRules: [] }] }, context, scope());
    expect(result).toHaveProperty('excerpt', prepared.excerpt); expect(requests).toHaveLength(1);
    await expect(new MixedDepthClassifier(value, () => ({ longNoteStrategy: 'full' })).propose(input, { revision: 1, targets: [{ id: 'a', path: '研究', directPurpose: '', effectiveRules: [] }] }, context, scope())).rejects.toMatchObject({ code: 'limit' });
  });
  it('accounts for JSON escaping and leaves short notes unchanged', () => {
    expect(prepareNote(note).note).toBe(note);
    expect(byteLength(prepareNote({ ...note, body: '\n"\\'.repeat(10000) }).note.body)).toBeLessThanOrEqual(12000);
  });
});

describe('ranked provider boundary', () => {
  it('migrates old settings and requires explicit HTTP(S) destinations', () => {
    expect(parseSettings({ modelId: 'jev-1.13.0', secretName: 'old' })).toMatchObject({ provider: 'jev', secretName: 'old', longNoteStrategy: 'excerpt', folderProfilesEnabled: false });
    for (const endpoint of ['file:///tmp/a', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=x']) expect(() => parseSettings({ provider: 'openai-compatible', endpoint })).toThrow();
  });
  it('allows keyless loopback OpenAI compatible APIs, pins config model identity and parses usage', async () => {
    const post = vi.fn(async () => ({ status: 200, headers: {}, json: { model: 'resolved-model-version', choices: [{ finish_reason: 'stop', message: { content: ranked } }], usage: { prompt_tokens: 12 } } }));
    const client = createDecisionClient({ post }, { get: () => null }, () => ({ provider: 'openai-compatible', endpoint: 'http://localhost:11434/v1' }));
    expect(await client.evaluate(batch)).toMatchObject({ modelId: batch.modelId, inputTokens: 12, answers: { pick: { selected: 'yes', confidence: 0 } } });
    expect(post).toHaveBeenCalledWith('http://localhost:11434/v1/chat/completions', { 'Content-Type': 'application/json' }, expect.any(String));
  });
  it('uses Anthropic headers and refuses incomplete output', async () => {
    const post = vi.fn(async () => ({ status: 200, headers: {}, json: { stop_reason: 'end_turn', content: [{ type: 'text', text: ranked }], usage: { input_tokens: 7 } } }));
    const client = createDecisionClient({ post }, { get: () => 'synthetic-key' }, () => ({ provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1' }));
    expect((await client.evaluate(batch)).inputTokens).toBe(7);
    expect(post).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.objectContaining({ 'x-api-key': 'synthetic-key', 'anthropic-version': '2023-06-01' }), expect.any(String));
    post.mockResolvedValueOnce({ status: 200, headers: {}, json: { stop_reason: 'max_tokens', content: [{ type: 'text', text: ranked }], usage: { input_tokens: 7 } } });
    await expect(client.evaluate(batch)).rejects.toMatchObject({ code: 'invalid-response' });
  });
  it.each([['yes', 'outside'], ['yes', 'yes'], ['no', 'yes'], ['yes']])('rejects invalid ranking %j', (...ranking) => {
    expect(() => parseStructuredResponse(JSON.stringify({ answers: { pick: { choice: 'yes', ranking } } }), batch, null)).toThrow();
  });
  it.each([[401, 'authentication'], [429, 'rate-limit'], [503, 'service']])('maps status %s for scheduling', async (status, code) => {
    const client = createDecisionClient({ post: async () => ({ status: Number(status), headers: { 'retry-after': '2' }, json: { private: 'do not expose' } }) }, { get: () => 'synthetic-key' }, () => ({ provider: 'openai-compatible', endpoint: 'https://example.com/v1' }));
    await expect(client.evaluate(batch)).rejects.toMatchObject({ code });
  });
  it('requires a credential for remote endpoints before sending', async () => {
    const post = vi.fn(); const client = createDecisionClient({ post }, { get: () => null }, () => ({ provider: 'openai-compatible', endpoint: 'https://example.com/v1' }));
    await expect(client.evaluate(batch)).rejects.toMatchObject({ code: 'authentication' }); expect(post).not.toHaveBeenCalled();
  });
});

describe('opt-in local folder profiles', () => {
  const targets = Array.from({ length: 300 }, (_, i) => ({ id: 'f' + i, path: 'Folder' + i, directPurpose: '', effectiveRules: [] }));
  it('retains a synthetic known destination with less request data; weak evidence keeps every destination', async () => {
    const profiles = new MemoryFolderProfiles();
    profiles.upsert({ path: 'Folder299/article.md', title: 'Quantum error correction', tags: ['physics'] });
    const input = { ...note, title: 'Quantum error correction', body: 'Quantum error correction', tags: ['physics'] };
    const enriched = profiles.enrich(targets); const narrowed = profiles.prefilter(input, enriched);
    expect(narrowed).toHaveLength(64); expect(narrowed.map(item => item.id)).toContain('f299');
    expect(profiles.prefilter(note, enriched)).toHaveLength(300);
    const baseline = scheduler(); const filtered = scheduler();
    await new MixedDepthClassifier(baseline.value).propose(input, { revision: 1, targets }, context, scope());
    await new MixedDepthClassifier(filtered.value, () => ({ profiles })).propose(input, { revision: 1, targets }, context, scope());
    expect(filtered.requests.reduce((sum, request) => sum + byteLength(request), 0)).toBeLessThan(baseline.requests.reduce((sum, request) => sum + byteLength(request), 0));
    expect(JSON.stringify(baseline.requests)).not.toContain('article.md');
    profiles.remove('Folder299/article.md'); expect(profiles.enrich(targets).some(item => item.profile)).toBe(false);
  });
  it('preserves manually configured destinations and bounds profile samples', () => {
    const profiles = new MemoryFolderProfiles();
    for (let i = 0; i < 30; i++) profiles.upsert({ path: `Folder299/${i}.md`, title: 'Quantum error correction', tags: ['physics'] });
    const configured = targets.map((target, i) => i === 200 ? { ...target, directPurpose: 'Personal use' } : target);
    const enriched = profiles.enrich(configured); expect(enriched[299]?.profile?.titles).toHaveLength(8);
    expect(profiles.prefilter({ ...note, title: 'Quantum correction', tags: [] }, enriched).map(item => item.id)).toContain('f200');
    profiles.clear(); expect(profiles.enrich(targets).some(item => item.profile)).toBe(false);
    expect(DEFAULT_SETTINGS.folderProfilesEnabled).toBe(false);
  });
});

describe('profile shortlist recall safeguards', () => {
  const targets = Array.from({ length: 300 }, (_, i) => ({ id: 'f' + i, path: 'Folder' + i, directPurpose: '', effectiveRules: [] }));
  const input = { ...note, title: 'Quantum error correction', body: 'Quantum error correction', tags: ['physics'] };
  it('keeps the full catalogue when protected and matching destinations together exceed the shortlist', () => {
    const profiles = new MemoryFolderProfiles();
    profiles.upsert({ path: 'Folder299/article.md', title: input.title, tags: input.tags });
    const configured = targets.map((target, i) => i < 64 ? { ...target, directPurpose: 'Protected purpose' } : target);
    expect(profiles.prefilter(input, profiles.enrich(configured))).toHaveLength(300);
  });
  it('retries with every group once when the shortlist is unassigned', async () => {
    const profiles = new MemoryFolderProfiles(); profiles.upsert({ path: 'Folder299/article.md', title: input.title, tags: input.tags });
    const { value, requests } = scheduler();
    value.evaluate = vi.fn(async request => { requests.push(request); return answer(request, ids => requests.length === 1 ? 'unassigned' : ids[0]!); });
    const proposal = await new MixedDepthClassifier(value, () => ({ profiles })).propose(input, { revision: 1, targets }, context, scope());
    expect(requests[0]?.questions[0]?.options).toHaveLength(65);
    const groups = requests.slice(1).flatMap(request => request.questions).filter(question => question.id.startsWith('group'));
    expect(new Set(groups.flatMap(question => question.options.filter(option => option.id !== 'unassigned').map(option => option.id))).size).toBe(300);
    expect(proposal.selected).not.toBeNull();
  });
  it('processes long contiguous Chinese metadata without repeated full-string decoding', () => {
    const profiles = new MemoryFolderProfiles(); profiles.upsert({ path: 'Folder299/article.md', title: '量子计算', tags: ['量子纠错'] });
    const result = profiles.prefilter({ ...note, title: '量子纠错', body: '量子计算'.repeat(3000), tags: [] }, profiles.enrich(targets));
    expect(result.map(target => target.id)).toContain('f299');
  });
});

it('keeps optional dense multilingual profiles within the classification budget', async () => {
  const profiles = new MemoryFolderProfiles();
  const targets = Array.from({ length: 300 }, (_, i) => ({ id: 'f' + i, path: 'Folder' + i, directPurpose: '', effectiveRules: [] }));
  for (const target of targets) for (let sample = 0; sample < 8; sample++) profiles.upsert({ path: `${target.path}/${sample}.md`, title: '研究'.repeat(60), tags: Array.from({ length: 12 }, (_, i) => String(i) + '主题'.repeat(40)) });
  expect(profiles.enrich(targets).every(target => byteLength(target.profile) <= 1000)).toBe(true);
  const { value, requests } = scheduler();
  const proposal = await new MixedDepthClassifier(value, () => ({ profiles })).propose({ ...note, body: '其他文字'.repeat(7500) }, { revision: 1, targets }, context, scope());
  expect(proposal.selected).not.toBeNull();
  expect(requests.length).toBeGreaterThan(1);
  expect(JSON.stringify(requests.at(-1)?.questions)).not.toContain('profile');
});

describe('explicit Ollama structured output', () => {
  it('uses explicit loopback defaults and does not change generic compatible requests', async () => {
    expect(parseSettings({ provider: 'ollama' })).toMatchObject({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434/v1', modelId: 'qwen3:1.7b' });
    const post = vi.fn<HttpTransport['post']>(async () => ({ status: 200, headers: {}, json: { choices: [{ finish_reason: 'stop', message: { content: ranked } }] } }));
    for (const provider of ['ollama', 'openai-compatible'] as const) {
      await createDecisionClient({ post }, { get: () => null }, () => ({ provider, endpoint: 'http://127.0.0.1:11579/v1' })).evaluate(batch);
    }
    const request = JSON.parse(post.mock.calls[0]![2]!) as { response_format: unknown };
    expect(request.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
    expect(request.response_format).toHaveProperty('json_schema.schema.additionalProperties', false);
    expect(request.response_format).toHaveProperty('json_schema.schema.properties.answers.required', ['pick']);
    expect(request.response_format).toHaveProperty('json_schema.schema.properties.answers.properties.pick', { type: 'object', additionalProperties: false, required: ['choice', 'probabilities'], properties: { choice: { type: 'string', enum: ['yes', 'no'] }, probabilities: { type: 'object', additionalProperties: false, required: ['yes', 'no'], properties: { yes: { type: 'integer' }, no: { type: 'integer' } } } } });
    // Generic compatible servers also try structured output first; unsupported ones fall back (see structured-output.test.ts).
    expect(JSON.parse(post.mock.calls[1]![2]!).response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
  });
  it.each([
    { answers: { pick: { choice: 'no', ranking: ['yes', 'no'] } } },
    { answers: { pick: { choice: 'yes', ranking: ['yes', 'yes'] } } },
    { answers: { pick: { choice: 'yes', ranking: ['yes', 'outside'] } } },
    { answers: { wrong: { choice: 'yes', ranking: ['yes', 'no'] } } },
  ])('still rejects contradictory, duplicate, outside or wrong-question model output', async response => {
    const client = createDecisionClient({ post: async () => ({ status: 200, headers: {}, json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] } }) }, { get: () => null }, () => ({ provider: 'ollama', endpoint: 'http://127.0.0.1:11579/v1' }));
    // One compatible-mode retry is offered; the same answer is still rejected.
    await expect(client.evaluate(batch)).rejects.toMatchObject({ code: 'format' });
    await expect(client.evaluate(batch)).rejects.toMatchObject({ code: 'invalid-response' });
  });
  it('does not send keyless requests to remote Ollama hosts', async () => {
    const post = vi.fn();
    const client = createDecisionClient({ post }, { get: () => null }, () => ({ provider: 'ollama', endpoint: 'https://example.com/v1' }));
    await expect(client.evaluate(batch)).rejects.toMatchObject({ code: 'authentication' }); expect(post).not.toHaveBeenCalled();
  });
  it.each([[401, 'authentication'], [429, 'rate-limit']] as const)('maps Ollama HTTP %s without exposing response content', async (status, code) => {
    const client = createDecisionClient({ post: async () => ({ status, headers: { 'retry-after': '2' }, json: { error: 'private model diagnostics' } }) }, { get: () => null }, () => ({ provider: 'ollama', endpoint: 'http://127.0.0.1:11579/v1' }));
    await expect(client.evaluate(batch)).rejects.toMatchObject({ code });
  });

});
