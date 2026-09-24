import { build } from 'esbuild';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// Production modules only; Obsidian's fuzzy search is replaced by a substring scorer of similar cost.
const entry = `export { MemoryMetadataIndex } from './src/linking/metadata-index';
export { MemoryLinkGraph } from './src/linking/link-graph';
export { LocalMentionMatcher } from './src/linking/mention-matcher';
export { searchTargets } from './src/linking/target-search';`;
const result = await build({ stdin: { contents: entry, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { MemoryMetadataIndex, MemoryLinkGraph, LocalMentionMatcher, searchTargets } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const NOTES = 20000, percentile = (values, p) => values.sort((a, b) => a - b)[Math.floor(values.length * p)];
const index = new MemoryMetadataIndex(), graph = new MemoryLinkGraph();
global.gc?.();
const baseline = process.memoryUsage().heapUsed, started = performance.now();
for (let id = 0; id < NOTES; id++) {
  const title = id % 3 === 0 ? `Concept-${id} 学习笔记` : id % 3 === 1 ? `2024-01-02 读书笔记：概念${id}` : `主题${id}（Topic${id}）`;
  index.upsert({ noteId: id, path: `Resources/Group${id % 50}/${title}.md`, title, aliases: [`别名${id}`], tags: ['synthetic'], description: '', revision: 0 });
}
const indexMs = performance.now() - started, graphStart = performance.now();
for (let id = 0; id < NOTES; id++) graph.replaceSource(id, Array.from({ length: 5 }, (_, k) => ({ targetId: (id * 7 + k * 131) % NOTES, anchor: `别名${(id * 7 + k * 131) % NOTES}` })));
const graphMs = performance.now() - graphStart;
global.gc?.();
const heapMiB = (process.memoryUsage().heapUsed - baseline) / 1024 / 1024;
const sentence = '我们讨论 Concept-123 与概念568 的关系，也提到主题302和 Topic905。另外别名77很重要。';
const text = sentence.repeat(Math.ceil(5000 / sentence.length)).slice(0, 5000);
const matcher = new LocalMentionMatcher(index, graph);
const request = { sourceNoteId: 1, sourcePath: 'Inbox/source.md', text, offset: 0, allowedRanges: [{ from: 0, to: text.length }], linkedNoteIds: new Set(), ignoredTerms: new Set(), allowed: () => true };
for (let i = 0; i < 20; i++) matcher.scan(request);
const scans = [], mentions = matcher.scan(request).length;
for (let i = 0; i < 300; i++) { const began = performance.now(); matcher.scan(request); scans.push(performance.now() - began); }
const searches = [];
for (const query of ['concept-12', '概念56', 'topic90', '别名7', '主题3']) for (let i = 0; i < 20; i++) {
  const began = performance.now(); searchTargets(index, graph, { scorer: term => term.includes(query) ? -term.length : null, query, sourceNoteId: 1, sourcePath: 'Inbox/source.md', allowed: () => true }); searches.push(performance.now() - began);
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, architecture: process.arch, notes: NOTES, indexBuildMs: +indexMs.toFixed(1), graphBuildMs: +graphMs.toFixed(1), heapDeltaMiB: +heapMiB.toFixed(1),
  viewportUtf16: text.length, mentionsPerScan: mentions, scanMedianMs: +percentile(scans, .5).toFixed(3), scanP95Ms: +percentile(scans, .95).toFixed(3),
  searchMedianMs: +percentile(searches, .5).toFixed(2), searchP95Ms: +percentile(searches, .95).toFixed(2), bodyReads: 0 }, null, 2));
