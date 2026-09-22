import { build } from 'esbuild';
import { performance } from 'node:perf_hooks';

const result = await build({ entryPoints: [new URL('../src/linking/metadata-index.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
const { MemoryMetadataIndex } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const index = new MemoryMetadataIndex();
const aliasesPerNote = Number(process.argv[2] ?? 1);
if (![1, 2].includes(aliasesPerNote)) throw new Error('Choose one or two aliases per note.');
global.gc?.();
const baseline = process.memoryUsage().heapUsed, start = performance.now();
for (let id = 0; id < 20000; id++) index.upsert({ noteId: id, path: `Resources/Group${id % 50}/Concept-${id}.md`, title: `Concept-${id}`, aliases: [`概念${id}`, `Topic${id}`].slice(0, aliasesPerNote), tags: ['synthetic'], description: '', revision: 0 });
const startupMs = performance.now() - start;
global.gc?.();
const heapDeltaMiB = (process.memoryUsage().heapUsed - baseline) / 1024 / 1024;
const text = '讨论 Concept-123 和概念567，与 Concept-999 的联系。'.padEnd(1200, '无');
for (let i = 0; i < 100; i++) index.match(text);
const times = [];
for (let i = 0; i < 1000; i++) { const began = performance.now(); const result = index.match(text); if (result.matches.length !== 3) throw new Error('Unexpected benchmark matches'); times.push(performance.now() - began); }
times.sort((a, b) => a - b);
console.log(JSON.stringify({ node: process.version, platform: process.platform, architecture: process.arch, notes: index.size, termsPerNote: aliasesPerNote + 1, windowUtf16: text.length, queries: times.length, startupMs: +startupMs.toFixed(2), heapDeltaMiB: +heapDeltaMiB.toFixed(2), queryMedianMs: +times[500].toFixed(3), queryP95Ms: +times[950].toFixed(3), bodyReads: 0 }, null, 2));
