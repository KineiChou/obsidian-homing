import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? '/private/tmp/profile-evaluation-results.json');
const bundle = await build({ stdin: { contents: "export * from './scripts/profile-evaluation-corpus.ts'; export { JevClient } from './src/jev/client.ts';", resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { JevClient, evaluateProfiles, MAX_REQUESTS, CORPUS_ID, MODEL } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
await writeFile(output, JSON.stringify({ status: 'not-run', corpus: CORPUS_ID, model: MODEL, maxRequests: MAX_REQUESTS, reason: 'Awaiting a stdin credential and live execution. No quality measurements exist yet.' }, null, 2) + '\n');
process.stdout.write('Waiting for Jev key on stdin; input is not echoed or saved.\n');
let key = '';
try {
  key = await new Promise((resolveKey, reject) => {
    let value = ''; let finished = false;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    const finish = error => {
      if (finished) return; finished = true;
      process.stdin.off('data', data); process.stdin.off('end', end); process.stdin.pause();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      if (error) reject(error); else if (!value.trim()) reject(new Error('Missing credential')); else resolveKey(value.trim());
    };
    const end = () => finish();
    const data = chunk => { const text = String(chunk); if (text.includes('\u0003')) return finish(new Error('Cancelled')); const at = text.search(/[\r\n]/); value += at < 0 ? text : text.slice(0, at); if (value.length > 8192) return finish(new Error('Invalid credential')); if (at >= 0) finish(); };
    process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.resume();
  });
  let requests = 0; const rows = [];
  const client = new JevClient({ post: async (url, headers, body) => {
    if (requests >= MAX_REQUESTS) throw new Error('Request cap');
    requests++;
    const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
    let json = null; try { json = await response.json(); } catch { /* Preserve status without exposing a response body. */ }
    return { status: response.status, headers: Object.fromEntries(response.headers), json };
  } }, { get: () => key });
  try {
    const report = await evaluateProfiles(client, () => requests, row => { rows.push(row); console.log(JSON.stringify(row)); });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, output, summary: report.summary }));
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z-]{1,40}$/.test(error.code) ? error.code : 'execution-failed';
    await writeFile(output, JSON.stringify({ status: 'incomplete', corpus: CORPUS_ID, model: MODEL, maxRequests: MAX_REQUESTS, actualRequests: requests, code, rows }, null, 2) + '\n');
    console.log(JSON.stringify({ status: 'incomplete', output, actualRequests: requests, code })); process.exitCode = 1;
  }
} catch { console.log(JSON.stringify({ status: 'not-run', output, code: 'stdin-unavailable' })); process.exitCode = 1; }
finally { key = ''; }
