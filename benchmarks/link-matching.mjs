import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Synthetic, pre-normalized labels only: no vault access, parser, model, or disk search.
const topics = [
  '机器学习', '概率模型', '注意力机制', '数据库', '编译器', '网络协议',
  '知识管理', '项目规划', '线性代数', '信号处理', '认知科学', '信息检索',
  'neural network', 'distributed system', 'type inference', 'vector search',
  'language model', 'query optimizer', 'graph theory', 'audio encoder',
];

function randomGenerator(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function dataset(noteCount) {
  const random = randomGenerator(73);
  const labels = new Set(['机器学习', '学习', 'vector search']);
  for (let i = 0; i < noteCount; i++) {
    const first = topics[Math.floor(random() * topics.length)];
    const second = topics[Math.floor(random() * topics.length)];
    const id = i.toString(36);
    labels.add(`${first} ${second} ${id}`);
    labels.add(`${second} 实验${id}`);
  }
  const terms = [...labels];
  const filler = '这段普通文字记录了实验背景与观察结果，需要结合当前上下文判断概念。 everyday notes and observations. ';
  const queries = Array.from({ length: 160 }, (_, i) => {
    const chosen = terms[Math.floor(random() * terms.length)];
    const other = terms[Math.floor(random() * terms.length)];
    const middle = i % 4 === 0 ? '没有词典提及的段落' : `${chosen}，还有 ${other}。`;
    return `${filler.repeat(7)} ${middle} ${filler.repeat(7)}`.slice(0, 1200);
  });
  return { terms, queries };
}

function makeLinear(terms) {
  return (text) => {
    const matches = [];
    for (let id = 0; id < terms.length; id++) {
      const term = terms[id];
      let from = 0;
      while (true) {
        const at = text.indexOf(term, from);
        if (at < 0) break;
        matches.push([at, at + term.length, id]);
        from = at + 1;
      }
    }
    return matches;
  };
}

function radixNode() { return { edges: new Map(), terminal: -1 }; }

function makeRadix(terms) {
  const root = radixNode();
  for (let id = 0; id < terms.length; id++) {
    let node = root;
    let rest = terms[id];
    while (rest.length) {
      const key = rest.charCodeAt(0);
      const edge = node.edges.get(key);
      if (!edge) {
        const child = radixNode();
        child.terminal = id;
        node.edges.set(key, { label: rest, child });
        break;
      }
      let common = 0;
      while (common < rest.length && common < edge.label.length && rest[common] === edge.label[common]) common++;
      if (common === edge.label.length) {
        node = edge.child;
        rest = rest.slice(common);
        if (!rest.length) node.terminal = id;
        continue;
      }
      const branch = radixNode();
      const oldSuffix = edge.label.slice(common);
      branch.edges.set(oldSuffix.charCodeAt(0), { label: oldSuffix, child: edge.child });
      edge.label = edge.label.slice(0, common);
      edge.child = branch;
      rest = rest.slice(common);
      if (rest.length) {
        const child = radixNode();
        child.terminal = id;
        branch.edges.set(rest.charCodeAt(0), { label: rest, child });
      } else {
        branch.terminal = id;
      }
      break;
    }
  }
  return (text) => {
    const matches = [];
    for (let start = 0; start < text.length; start++) {
      let node = root;
      let at = start;
      while (at < text.length) {
        const edge = node.edges.get(text.charCodeAt(at));
        if (!edge || !text.startsWith(edge.label, at)) break;
        at += edge.label.length;
        node = edge.child;
        if (node.terminal >= 0) matches.push([start, at, node.terminal]);
      }
    }
    return matches;
  };
}

function makeAhoCorasick(terms) {
  const nodes = [{ edges: new Map(), fail: 0, output: 0, terminal: -1 }];
  for (let id = 0; id < terms.length; id++) {
    let state = 0;
    for (let at = 0; at < terms[id].length; at++) {
      const code = terms[id].charCodeAt(at);
      let next = nodes[state].edges.get(code);
      if (next === undefined) {
        next = nodes.length;
        nodes.push({ edges: new Map(), fail: 0, output: 0, terminal: -1 });
        nodes[state].edges.set(code, next);
      }
      state = next;
    }
    nodes[state].terminal = id;
  }
  const queue = [...nodes[0].edges.values()];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const parent = queue[cursor];
    for (const [code, child] of nodes[parent].edges) {
      let fallback = nodes[parent].fail;
      while (fallback && !nodes[fallback].edges.has(code)) fallback = nodes[fallback].fail;
      nodes[child].fail = nodes[fallback].edges.get(code) ?? 0;
      const failed = nodes[child].fail;
      nodes[child].output = nodes[failed].terminal >= 0 ? failed : nodes[failed].output;
      queue.push(child);
    }
  }
  return (text) => {
    const matches = [];
    let state = 0;
    for (let at = 0; at < text.length; at++) {
      const code = text.charCodeAt(at);
      while (state && !nodes[state].edges.has(code)) state = nodes[state].fail;
      state = nodes[state].edges.get(code) ?? 0;
      let output = state;
      while (output) {
        const id = nodes[output].terminal;
        if (id >= 0) matches.push([at + 1 - terms[id].length, at + 1, id]);
        output = nodes[output].output;
      }
    }
    return matches;
  };
}

const builders = { linear: makeLinear, radix: makeRadix, ahoCorasick: makeAhoCorasick };
const normalizeMatches = (matches) => matches.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

function verify() {
  const { terms, queries } = dataset(1000);
  const explicit = ['a', 'ab', 'bab', 'bc', 'bca', 'c', 'caa', '机器学习', '学习', '🧠模型'];
  for (const [dictionary, texts] of [[terms, queries.slice(0, 30)], [explicit, ['abccab', '机器学习与🧠模型', 'aaaa']]]) {
    const oracle = makeLinear(dictionary);
    for (const build of [makeRadix, makeAhoCorasick]) {
      const match = build(dictionary);
      for (const text of texts) assert.deepEqual(normalizeMatches(match(text)), normalizeMatches(oracle(text)));
    }
  }
}

function measure(method, noteCount) {
  const { terms, queries } = dataset(noteCount);
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const match = builders[method](terms);
  const buildMs = performance.now() - started;
  global.gc();
  const indexHeapMiB = Math.max(0, process.memoryUsage().heapUsed - before) / 1024 ** 2;
  let checksum = 0;
  for (let i = 0; i < 40; i++) checksum += match(queries[i]).length;
  const timings = [];
  for (const query of queries) {
    const start = performance.now();
    checksum += match(query).length;
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  const round = (value) => Number(value.toFixed(4));
  return {
    method, noteCount, termCount: terms.length,
    queryLength: { min: Math.min(...queries.map(q => q.length)), max: Math.max(...queries.map(q => q.length)) },
    queries: queries.length, buildMs: round(buildMs), indexHeapMiB: round(indexHeapMiB),
    p50Ms: round(timings[Math.floor(timings.length * 0.5)]),
    p95Ms: round(timings[Math.floor(timings.length * 0.95)]), checksum,
  };
}

if (process.argv[2] === '--worker') {
  assert.equal(typeof global.gc, 'function');
  process.stdout.write(JSON.stringify(measure(process.argv[3], Number(process.argv[4]))));
} else {
  verify();
  const measurements = [];
  for (const notes of [5000, 20000]) {
    for (const method of Object.keys(builders)) {
      const run = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--worker', method, String(notes)], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      measurements.push(JSON.parse(run.stdout));
    }
    const checksums = measurements.filter(m => m.noteCount === notes).map(m => m.checksum);
    assert.equal(new Set(checksums).size, 1);
  }
  process.stdout.write(JSON.stringify({
    runtime: process.version, platform: process.platform, architecture: process.arch,
    measuredAt: new Date().toISOString(),
    scope: 'Synthetic label matching only. Index heap excludes input labels, metadata, postings, editor, network, and peak construction memory. Not an Obsidian benchmark.',
    correctness: 'Outputs matched an indexOf oracle on synthetic samples and overlapping/Unicode fixtures; timed runs have equal match-count checksums.',
    measurements,
  }, null, 2) + '\n');
}
