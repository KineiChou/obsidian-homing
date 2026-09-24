import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { cases, batchFor, evaluationPlan, evaluatePlan, summarize, filingInstructions, linkInstructions } from './prompt-evaluation-cases.mjs';

test('paired batches change only instructions and preserve local JSON', () => {
  assert.equal(evaluationPlan().length, 16);
  for (const domain of ['filing', 'link']) for (const language of ['zh', 'en', 'mixed']) {
    assert.ok(cases.some(sample => sample.domain === domain && sample.language === language));
  }
  for (const sample of cases) {
    const zh = batchFor(sample, 'zh'); const en = batchFor(sample, 'en');
    assert.notEqual(zh.questions[0].instructions, en.questions[0].instructions);
    if (sample.local) for (const batch of [zh, en]) assert.ok(batch.questions[0].instructions.endsWith(JSON.stringify(sample.local)));
    zh.questions[0].instructions = en.questions[0].instructions = '';
    assert.deepEqual(zh, en);
    assert.ok(sample.options.some(option => option.id === sample.expected));
  }
});
test('Chinese baselines match current production prompts', async () => {
  const classifier = await readFile(new URL('../src/filing/classifier.ts', import.meta.url), 'utf8');
  const recommender = await readFile(new URL('../src/linking/recommender.ts', import.meta.url), 'utf8');
  assert.ok(classifier.includes(`const INSTRUCTIONS = '${filingInstructions.zh}';`));
  assert.ok(recommender.includes(linkInstructions.zh + '${JSON.stringify(description)}'));
});
test('runs exactly 16 requests without retries and emits metadata only', async () => {
  let count = 0; const output = [];
  const client = { evaluate: async batch => {
    const sample = evaluationPlan()[count++].sample;
    return { modelId: batch.modelId, answers: { [batch.questions[0].id]: { selected: sample.expected } }, inputTokens: count === 1 ? null : 100 };
  } };
  const result = await evaluatePlan(client, record => output.push(record), () => 0);
  assert.equal(count, 16); assert.equal(result.failed, false);
  assert.ok(output.every(record => record.hit));
  const text = JSON.stringify(output);
  for (const sample of cases) {
    assert.ok(!text.includes(sample.state.note?.body ?? sample.local.context));
  }
  const summary = summarize(result.records);
  assert.deepEqual(summary.map(arm => arm.pairedHits), [8, 8]);
  assert.equal(summary[0].unknownTokenRequests, 1);
});
test('failed request stops immediately and does not expose error or response text', async () => {
  let count = 0; const output = [];
  const result = await evaluatePlan({ evaluate: async () => { count++; throw new Error('SECRET BODY'); } }, record => output.push(record), () => 0);
  assert.equal(count, 1); assert.equal(result.failed, true);
  assert.ok(!JSON.stringify(output).includes('SECRET BODY'));
  const invalid = [];
  await evaluatePlan({ evaluate: async () => ({ answers: { destination: { selected: 'PRIVATE RESPONSE' } }, inputTokens: 1 }) }, record => invalid.push(record), () => 0);
  assert.ok(!JSON.stringify(invalid).includes('PRIVATE RESPONSE'));
});
test('default dry run needs no stdin or network', () => {
  const result = spawnSync(process.execPath, [new URL('./prompt-evaluation.mjs', import.meta.url).pathname], { input: '', encoding: 'utf8' });
  assert.equal(result.status, 0);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.mode, 'dry-run'); assert.equal(plan.requests, 16);
});
test('all fixtures pass production serialization and response validation offline', async () => {
  const { build } = await import('esbuild');
  const bundle = await build({ entryPoints: [new URL('../src/jev/client.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
  const { JevClient } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  let count = 0;
  const client = new JevClient({ post: async (_url, _headers, body) => {
    const request = JSON.parse(body);
    const sample = evaluationPlan()[count++].sample;
    const [id, question] = Object.entries(request.questions)[0];
    return { status: 200, headers: {}, json: { model: request.model, answers: { [id]: { type: 'choice', choice: sample.expected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, option === sample.expected ? 1 : 0])) } }, usage: { input_tokens: 100 } } };
  } }, { get: () => 'synthetic-offline-placeholder' });
  const result = await evaluatePlan(client, () => {});
  assert.equal(result.failed, false); assert.equal(count, 16);
});
