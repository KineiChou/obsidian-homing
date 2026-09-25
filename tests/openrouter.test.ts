import { describe, expect, it, vi } from 'vitest';
import { createDecisionClient } from '../src/providers/client';
import { DEFAULT_SETTINGS, parseSettings, PROVIDER_DEFAULTS } from '../src/settings';
import { PluginStateStore } from '../src/storage/state-store';
import type { ChoiceBatch, HttpResponse } from '../src/jev/types';

const batch: ChoiceBatch = {
  modelId: 'openai/gpt-4.1-mini', state: { note: 'Synthetic classification example.' },
  questions: [{ id: 'pick', instructions: 'Choose the best category.', options: [{ id: 'yes', description: 'Learning' }, { id: 'none', description: 'No match' }] }],
};
function completion(content = JSON.stringify({ answers: { pick: { choice: 'yes', ranking: ['yes', 'none'] } } })) {
  return { choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 21 } };
}
function fixture(response: HttpResponse = { status: 200, headers: {}, json: completion() }, secret: string | null = 'synthetic-key') {
  const post = vi.fn(async () => response);
  const client = createDecisionClient({ post }, { get: () => secret }, () => ({ provider: 'openrouter', endpoint: PROVIDER_DEFAULTS.openrouter.endpoint }));
  return { post, client };
}

describe('OpenRouter protocol', () => {
  it('uses authenticated chat completions with strict candidate schema and supported-parameter routing', async () => {
    const f = fixture();
    const result = await f.client.evaluate(batch);
    expect(result).toMatchObject({ modelId: batch.modelId, inputTokens: 21, answers: { pick: { selected: 'yes', confidence: 0 } } });
    expect(f.post).toHaveBeenCalledWith('https://openrouter.ai/api/v1/chat/completions', { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-key' }, expect.any(String));
    const request = JSON.parse((f.post.mock.calls[0] as unknown as [string, unknown, string])[2]);
    expect(request).toMatchObject({ model: batch.modelId, stream: false, provider: { require_parameters: true }, response_format: { type: 'json_schema', json_schema: { strict: true } } });
    expect(request.response_format.json_schema.schema).toEqual({
      type: 'object', additionalProperties: false, required: ['answers'], properties: {
        answers: { type: 'object', additionalProperties: false, required: ['pick'], properties: {
          pick: { type: 'object', additionalProperties: false, required: ['choice', 'ranking'], properties: {
            choice: { type: 'string', enum: ['yes', 'none'] },
            ranking: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string', enum: ['yes', 'none'] } },
          } },
        } },
      },
    });
    expect(request.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'user']);
    expect(JSON.parse(request.messages[1].content)).toMatchObject({ state: batch.state });
  });
  it.each([null, '', '   '])('requires a key before sending (%s)', async secret => {
    const f = fixture(undefined, secret);
    await expect(f.client.evaluate(batch)).rejects.toMatchObject({ code: 'authentication', messageKey: 'error.secretMissing' });
    expect(f.post).not.toHaveBeenCalled();
  });
  it.each([[401, 'authentication'], [403, 'authentication'], [402, 'invalid-response'], [429, 'rate-limit'], [502, 'service'], [413, 'limit']] as const)('maps HTTP and embedded error %s without revealing content', async (status, code) => {
    for (const response of [
      { status, headers: { 'Retry-After': '2' }, json: { error: { code: status, message: 'private error details' } } },
      { status: 200, headers: { 'Retry-After': '2' }, json: { ...completion(), error: { code: status, message: 'private error details' } } },
      { status: 200, headers: { 'Retry-After': '2' }, json: { choices: [{ ...completion().choices[0], error: { code: status, message: 'private error details' } }] } },
    ]) {
      const error = await fixture(response).client.evaluate(batch).catch((error: unknown) => error);
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain('private error details');
      if (status === 429 || status === 502) expect(error).toMatchObject({ retryAfterMs: 2000 });
    }
  });
  it.each([null, {}, { code: 200 }, { code: '429' }])('rejects malformed embedded errors even alongside a valid answer', async error => {
    await expect(fixture({ status: 200, headers: {}, json: { ...completion(), error } }).client.evaluate(batch)).rejects.toMatchObject({ code: 'invalid-response' });
  });
  it.each([
    'not json',
    JSON.stringify({ answers: {} }),
    JSON.stringify({ answers: { pick: { choice: 'yes', ranking: ['yes', 'yes'] } } }),
    JSON.stringify({ answers: { pick: { choice: 'yes', ranking: ['none', 'yes'] } } }),
    JSON.stringify({ answers: { pick: { choice: 'unknown', ranking: ['unknown', 'none'] } } }),
    JSON.stringify({ answers: { pick: { choice: 'yes', ranking: ['yes'] } } }),
  ])('rejects invalid ranked content: %s', async content => {
    await expect(fixture({ status: 200, headers: {}, json: completion(content) }).client.evaluate(batch)).rejects.toMatchObject({ code: 'invalid-response' });
  });
  it.each(['length', 'error', 'content_filter'])('rejects incomplete finish reason %s', async finish_reason => {
    const json = completion(); json.choices[0]!.finish_reason = finish_reason;
    await expect(fixture({ status: 200, headers: {}, json }).client.evaluate(batch)).rejects.toMatchObject({ code: 'invalid-response' });
  });
});

describe('OpenRouter settings persistence', () => {
  it('keeps Jev as the existing default and supplies explicit OpenRouter defaults without a key reference', () => {
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ provider: 'openrouter' })).toMatchObject({ provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', modelId: 'openai/gpt-4.1-mini', secretName: '' });
    expect(parseSettings({ provider: 'openrouter', modelId: 'vendor/custom-model' }).modelId).toBe('vendor/custom-model');
    expect(() => parseSettings({ provider: 'openrouter', modelId: ' ' })).toThrow();
    expect(() => parseSettings({ provider: 'openrouter', endpoint: 'https://user:pass@example.com/v1' })).toThrow();
  });
  it('round-trips provider, model, endpoint and secret reference through persisted storage', async () => {
    let data: unknown = null;
    const port = { load: async () => data, save: async (value: unknown) => { data = structuredClone(value); }, loadLocal: () => null, saveLocal: () => undefined };
    const store = new PluginStateStore(port); await store.load();
    const settings = parseSettings({ provider: 'openrouter', modelId: 'vendor/custom-model', secretName: 'openrouter-key-reference' });
    await store.updateSettings(settings);
    const restored = new PluginStateStore(port); await restored.load();
    expect(restored.snapshot().settings).toEqual(settings);
    expect(JSON.stringify(data)).not.toContain('synthetic-key');
  });
});
