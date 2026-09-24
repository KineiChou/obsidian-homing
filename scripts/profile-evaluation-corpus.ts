import { MixedDepthClassifier } from '../src/filing/classifier';
import { MemoryFolderProfiles } from '../src/folders/profiles';
import { SharedDecisionScheduler } from '../src/jev/scheduler';
import type { DecisionClient, DailyUsage } from '../src/jev/types';
import type { FolderTarget } from '../src/folders/types';
import { OrganizerError } from '../src/core/errors';

export const MAX_REQUESTS = 40;
export const MODEL = 'jev-1.13.0';
export const CORPUS_ID = 'folder-profiles-synthetic-2026-09-24';
// Fixed, synthetic material only. Folder paths stay equal in both conditions.
export const domains = [
  { id: 'machine-learning', path: 'Resources/Models', purpose: '', titles: ['Transformer attention and sequence encoding', '注意力机制与神经网络训练'], tags: ['machine-learning', 'attention'], title: 'Transformer 注意力机制', body: '整理 Transformer 编码器的注意力机制：通过梯度下降训练神经网络，对音频序列建模。记录 attention 权重与训练损失的实验。', noteTags: ['machine-learning'] },
  { id: 'electrical-engineering', path: 'Resources/Systems', purpose: '', titles: ['Transformer windings and AC voltage conversion', '变压器绕组与交流电压'], tags: ['electrical-engineering', 'transformer'], title: 'Transformer voltage conversion', body: 'Bench notes on an electrical transformer: winding ratio, alternating current, insulation and AC voltage conversion. Compare primary and secondary winding measurements.', noteTags: ['electrical-engineering'] },
  { id: 'gardening', path: 'Resources/Fieldwork', purpose: '', titles: ['番茄育苗与菜园堆肥', 'Tomato seedling soil and compost'], tags: ['gardening', '种植'], title: '阳台番茄育苗与堆肥', body: '记录阳台菜园番茄种植：育苗土壤含水量、幼苗光照、堆肥用量以及移栽后的生长情况。', noteTags: ['种植'] },
  { id: 'music', path: 'Resources/Practice', purpose: '', titles: ['Jazz piano voicings and chord substitutions', '爵士钢琴和弦练习'], tags: ['music', 'piano'], title: 'Jazz piano chord practice', body: 'Practice jazz piano shell voicings, chord substitutions and ii-V-I progressions. Compare the left-hand chord shapes while playing a melody.', noteTags: ['piano'] },
  { id: 'astronomy', path: 'Resources/Observations', purpose: '', titles: ['木星观测与望远镜校准', 'Jupiter telescope eyepiece calibration'], tags: ['astronomy', '观星'], title: '木星望远镜观测记录', body: '记录木星观测时望远镜的目镜倍率、视宁度和卫星位置。校准 telescope 后比较木星云带的可见细节。', noteTags: ['观星'] },
  { id: 'baking', path: 'Resources/Workshop', purpose: 'Bread baking recipes and fermentation records', titles: ['Sourdough fermentation temperature and dough hydration', '酸面包发酵与含水率'], tags: ['baking', 'sourdough'], title: 'Sourdough fermentation log', body: 'Record sourdough bread dough hydration, starter activity and fermentation temperature. Compare oven spring after different bulk fermentation times.', noteTags: ['baking'] },
] as const;
export const samples = [...domains.map((domain, i) => ({ id: domain.id, expected: `f${i}`, title: domain.title, body: domain.body, tags: [...domain.noteTags] as string[] })), { id: 'ambiguous-unassigned', expected: null, title: 'Transformer', body: 'Transformer: a term to investigate later. No context or intended use recorded. 待补充背景。', tags: [] as string[] }];
export function corpus() {
  const targets: FolderTarget[] = Array.from({ length: 300 }, (_, i) => ({ id: `f${i}`, path: i < domains.length ? domains[i]!.path : `Archive/Collection-${String(i).padStart(3, '0')}`, directPurpose: i < domains.length ? domains[i]!.purpose : '', effectiveRules: [] }));
  const profiles = new MemoryFolderProfiles();
  domains.forEach((domain, i) => domain.titles.forEach((title, sample) => profiles.upsert({ path: `${targets[i]!.path}/Synthetic-${sample}.md`, title, tags: domain.tags })));
  for (let i = domains.length; i < targets.length; i++) profiles.upsert({ path: `${targets[i]!.path}/Index.md`, title: `Historical municipal archive collection ${i}`, tags: ['municipal', 'archive'] });
  return { targets, profiles };
}
export interface EvaluationRow { id: string; profiles: boolean; expected: string | null; selected: string | null; hit: boolean; requests: number; inputTokens: number; unknownTokenResponses: number }
export async function evaluateProfiles(client: DecisionClient, actualRequests: () => number, progress: (row: EvaluationRow) => void = () => undefined) {
  const { targets, profiles } = corpus();
  let requestsReserved = 0; let inputTokens = 0; let unknown = 0;
  const usage = {
    read: (): DailyUsage => ({ day: 'synthetic-evaluation', requests: requestsReserved, inputTokens, unknownRequests: unknown }),
    reserve: async () => { if (requestsReserved >= MAX_REQUESTS) throw new OrganizerError('budget', 'error.budgetReached'); requestsReserved++; },
    settle: async (tokens: number | null) => { if (tokens === null) unknown++; else inputTokens += tokens; },
  };
  const scheduler = new SharedDecisionScheduler(client, usage, () => MAX_REQUESTS, { maxRetries: 0, logicalTimeoutMs: 31_000, minAutomaticIntervalMs: 0 });
  const rows: EvaluationRow[] = [];
  try {
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index]!;
      // Alternate condition order to limit a consistent first-condition time bias.
      for (const enabled of index % 2 ? [true, false] : [false, true]) {
        const before = { requests: actualRequests(), inputTokens, unknown };
        const classifier = new MixedDepthClassifier(scheduler, () => ({ ...(enabled ? { profiles } : {}) }));
        const result = await classifier.propose({ source: { noteId: index, path: `Inbox/${sample.id}.md`, revision: 0, contentHash: `synthetic-${sample.id}` }, title: sample.title, body: sample.body, tags: sample.tags }, { revision: 1, targets }, { taskId: sample.id, settingsRevision: 0, promptRevision: 1, modelId: MODEL }, { key: `evaluation:${sample.id}:${enabled}`, priority: 'manual', automatic: false, isCurrent: () => true });
        const row = { id: sample.id, profiles: enabled, expected: sample.expected, selected: result.selected, hit: result.selected === sample.expected, requests: actualRequests() - before.requests, inputTokens: inputTokens - before.inputTokens, unknownTokenResponses: unknown - before.unknown };
        rows.push(row); progress(row);
      }
    }
    const summary = [false, true].map(enabled => { const group = rows.filter(row => row.profiles === enabled); return { profiles: enabled, cases: group.length, hits: group.filter(row => row.hit).length, requests: group.reduce((sum, row) => sum + row.requests, 0), inputTokens: group.reduce((sum, row) => sum + row.inputTokens, 0), unknownTokenResponses: group.reduce((sum, row) => sum + row.unknownTokenResponses, 0) }; });
    return { status: 'completed' as const, corpus: CORPUS_ID, model: MODEL, folderCount: targets.length, sampleCount: samples.length, maxRequests: MAX_REQUESTS, rows, summary, limitation: 'Small synthetic evaluation; paths are deliberately ambiguous. Results do not establish accuracy on real vaults. inputTokens sum only known service counts; inspect unknownTokenResponses.' };
  } finally { scheduler.dispose(); }
}
