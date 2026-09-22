import { build } from 'esbuild';
import { performance } from 'node:perf_hooks';

const bundled = await build({ entryPoints: [new URL('../src/jev/client.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
const { JevClient } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
process.stdout.write('Waiting for Jev key on stdin. The key is not echoed or saved.\n');
const key = await new Promise((resolve, reject) => {
  let value = '';
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const finish = error => {
    process.stdin.off('data', data); process.stdin.off('end', end); process.stdin.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    if (error) reject(error);
    else if (!value.trim()) reject(new Error('No key supplied on stdin.'));
    else resolve(value.trim());
  };
  const end = () => finish();
  const data = chunk => {
    const text = String(chunk);
    if (text.includes('\u0003')) { finish(new Error('Cancelled.')); return; }
    const newline = text.search(/[\r\n]/);
    value += newline < 0 ? text : text.slice(0, newline);
    if (newline >= 0) finish();
  };
  process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.resume();
});
const client = new JevClient({ post: async (url, headers, body) => {
  const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
  let json = null;
  try { json = await response.json(); } catch { /* The client interprets HTTP errors. */ }
  return { status: response.status, headers: Object.fromEntries(response.headers), json };
} }, { get: () => key });
const cases = [
  { id: 'connection', state: 'A short note about learning and reading.', instructions: 'Choose the matching subject.', options: [{ id: 'learning', description: 'Learning and reading' }, { id: 'unassigned', description: 'Other topics' }], expected: 'learning' },
  { id: 'filing_chinese', state: '这篇笔记记录注意力机制如何让 Transformer 编码器处理音频序列，训练时使用梯度下降优化模型。', instructions: '选择适合保存当前笔记的目录，不匹配时选择 unassigned。', options: [{ id: 'f1', description: 'Resources/机器学习：神经网络、注意力机制和模型训练' }, { id: 'f2', description: 'Resources/电气工程：变压器、电压与电流' }, { id: 'unassigned', description: '没有合适目录' }], expected: 'f1' },
  { id: 'link_chinese', state: '我们用 Transformer 编码音频序列，再进行文本解码。', instructions: '选择 Transformer 在当前句子中真正指向的概念，泛泛相关或信息不足时选择 unassigned。', options: [{ id: 'n1', description: '机器学习/Transformer.md：注意力机制和序列模型' }, { id: 'n2', description: '电气/Transformer.md：交流电压变换设备' }, { id: 'unassigned', description: '无需链接或信息不足' }], expected: 'n1' },
];
for (const sample of cases) {
  const start = performance.now();
  try {
    const response = await client.evaluate({ modelId: 'jev-1.13.0', state: sample.state, questions: [{ id: sample.id, instructions: sample.instructions, options: sample.options }] });
    const answer = response.answers[sample.id];
    const passed = answer.selected === sample.expected;
    console.log(JSON.stringify({ test: sample.id, model: response.modelId, selected: answer.selected, expected: sample.expected, passed, inputTokens: response.inputTokens, durationMs: Math.round(performance.now() - start) }));
    if (!passed) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ test: sample.id, passed: false, code: error.code ?? 'transport', message: error.code ? error.message : 'The live request did not complete.' }));
    process.exitCode = 1; break;
  }
}
