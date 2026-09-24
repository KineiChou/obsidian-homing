import { build } from 'esbuild';
import { performance } from 'node:perf_hooks';

const endpoint = new URL(process.argv[2] ?? 'http://127.0.0.1:11579/v1');
const modelId = process.argv[3] ?? 'qwen3:1.7b';
const repetitions = Number(process.argv[4] ?? 1);
const pins = { 'qwen3:0.6b': '7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435', 'qwen3:1.7b': '8f68893c685c3ddff2aa3fffce2aa60a30bb2da65ca488b61fff134a4d1730e7' };
if (!pins[modelId]) throw new Error('Choose a pinned local acceptance model.');
if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.pathname !== '/v1' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
  throw new Error('Use an explicit loopback HTTP endpoint ending in /v1.');
}
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('Repetitions must be an integer from 1 to 10.');
const metadata = async path => {
  const response = await fetch(new URL(path, endpoint), { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Local Ollama metadata returned HTTP ${response.status}.`);
  return response.json();
};
const version = await metadata('/api/version');
const installed = await metadata('/api/tags');
const model = installed.models?.find(item => item.name === modelId);
if (!model || model.digest !== pins[modelId] || model.remote_model || model.remote_host) throw new Error('The selected model must already exist in this local Ollama server. This script never pulls models.');
console.log(JSON.stringify({ runtime: version.version, model: modelId, digest: model.digest, sizeBytes: model.size, endpoint: endpoint.href, repetitions }));

const bundled = await build({ entryPoints: [new URL('../src/providers/client.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
const { createDecisionClient } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const client = createDecisionClient({ post: async (url, headers, body) => {
  if (url !== endpoint.href + '/chat/completions' || 'Authorization' in headers) throw new Error('Unexpected endpoint or credential header.');
  const response = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(120000) });
  let json = null;
  try { json = await response.json(); } catch { /* Production client validates the response. */ }
  return { status: response.status, headers: Object.fromEntries(response.headers), json };
} }, { get: () => null }, () => ({ provider: 'ollama', endpoint: endpoint.href }));
const cases = [
  { id: 'filing_ml', state: { note: { title: '注意力机制', body: '这篇笔记记录 Transformer 编码器如何利用自注意力处理音频序列，以及梯度下降训练模型。', tags: ['机器学习'] } }, instructions: '选择适合保存当前笔记的目录。不匹配时选择 unassigned。', options: [
    { id: 'f1', description: { path: 'Resources/机器学习', purpose: '神经网络、注意力机制和模型训练' } },
    { id: 'f2', description: { path: 'Resources/电气工程', purpose: '电压、电流和交流变压器' } },
    { id: 'unassigned', description: '没有合适目录' },
  ], expected: 'f1' },
  { id: 'filing_unassigned', state: { note: { title: '蛋糕食谱', body: '把鸡蛋、面粉、糖混合，放入烤箱烘焙蛋糕。', tags: ['食谱'] } }, instructions: '选择适合保存当前笔记的目录。如果所有目录主题都不匹配，必须选择 unassigned。', options: [
    { id: 'f1', description: { path: 'Resources/机器学习', purpose: '神经网络、注意力机制和模型训练' } },
    { id: 'f2', description: { path: 'Resources/电气工程', purpose: '电压、电流和交流变压器' } },
    { id: 'unassigned', description: '没有合适目录' },
  ], expected: 'unassigned' },
  { id: 'link_ml', state: { mention: 'Transformer', context: '我们用 Transformer 的注意力机制编码音频序列，再进行文本解码。', sourcePath: 'Inbox/音频编码.md' }, instructions: '选择 Transformer 在当前句子中真正指向的概念；不确定时选择 unassigned。', options: [
    { id: 'n1', description: { path: '机器学习/Transformer.md', description: '基于注意力机制的神经网络序列模型' } },
    { id: 'n2', description: { path: '电气/Transformer.md', description: '利用电磁感应改变交流电压的变压器' } },
    { id: 'unassigned', description: '无需链接或信息不足' },
  ], expected: 'n1' },
  { id: 'link_electrical', state: { mention: 'Transformer', context: '这个 Transformer 把交流电压从 220V 降到 12V，铁芯和线圈通过电磁感应工作。', sourcePath: 'Inbox/电路.md' }, instructions: '选择 Transformer 在当前句子中真正指向的概念；不确定时选择 unassigned。', options: [
    { id: 'n1', description: { path: '机器学习/Transformer.md', description: '基于注意力机制的神经网络序列模型' } },
    { id: 'n2', description: { path: '电气/Transformer.md', description: '利用电磁感应改变交流电压的变压器' } },
    { id: 'unassigned', description: '无需链接或信息不足' },
  ], expected: 'n2' },
];
let passed = 0;
for (let run = 1; run <= repetitions; run++) {
  for (const sample of cases) {
    const started = performance.now();
    try {
      const result = await client.evaluate({ modelId, state: sample.state, questions: [{ id: sample.id, instructions: sample.instructions, options: sample.options }] });
      const selected = result.answers[sample.id]?.selected;
      const success = selected === sample.expected;
      if (success) passed++;
      console.log(JSON.stringify({ run, test: sample.id, passed: success, selected, expected: sample.expected, inputTokens: result.inputTokens, durationMs: Math.round(performance.now() - started) }));
    } catch (error) {
      console.log(JSON.stringify({ run, test: sample.id, passed: false, code: error.code ?? 'transport', durationMs: Math.round(performance.now() - started) }));
    }
  }
}
const total = cases.length * repetitions;
console.log(JSON.stringify({ passed, total, strictProductionParser: true }));
if (passed !== total) process.exitCode = 1;
