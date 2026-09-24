import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { evaluationPlan, evaluatePlan, summarize } from './prompt-evaluation-cases.mjs';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !['--live', '--dry-run'].includes(args[0]))) {
  process.stderr.write('Usage: node scripts/prompt-evaluation.mjs [--dry-run|--live]\n');
  process.exit(1);
}
if (args[0] !== '--live') {
  console.log(JSON.stringify({ mode: 'dry-run', model: 'jev-1.13.0', requests: evaluationPlan().length, retries: 0, cases: [...new Set(evaluationPlan().map(({ sample }) => sample.id))] }));
} else {
  try { await run(); } catch {
    process.stderr.write('Evaluation could not start. No request or credential details are logged.\n');
    process.exitCode = 1;
  }
}
async function run() {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/jev/client.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' });
  const { JevClient } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  process.stderr.write('Enter Jev key on stdin (not echoed or saved). At most 16 requests; no retries.\n');
  const key = await readKey();
  const client = new JevClient({ post: async (url, headers, body) => {
    const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
    let json = null;
    try { json = await response.json(); } catch { /* Production client validates the response. */ }
    return { status: response.status, headers: Object.fromEntries(response.headers), json };
  } }, { get: () => key });
  const { records, failed } = await evaluatePlan(client, record => console.log(JSON.stringify(record)));
  console.log(JSON.stringify({ type: 'summary', complete: !failed, arms: summarize(records) }));
  if (failed) process.exitCode = 1;
}
function readKey() {
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    const finish = error => {
      process.stdin.off('data', data); process.stdin.off('end', end); process.stdin.off('error', failed); process.stdin.pause();
      if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(wasRaw));
      if (error || !value.trim()) reject(new Error('No key'));
      else resolve(value.trim());
    };
    const end = () => finish();
    const failed = () => finish(true);
    const data = chunk => {
      const text = String(chunk);
      if (text.includes('\u0003')) { finish(true); return; }
      const newline = text.search(/[\r\n]/);
      value += newline < 0 ? text : text.slice(0, newline);
      if (newline >= 0) finish();
    };
    process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.once('error', failed); process.stdin.resume();
  });
}
