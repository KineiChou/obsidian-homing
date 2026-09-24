import { describe, expect, it } from 'vitest';
import { corpus, domains, evaluateProfiles, MAX_REQUESTS, samples } from '../scripts/profile-evaluation-corpus';
import { answer } from './helpers';

describe('synthetic profile evaluation mechanics (not model quality evidence)', () => {
  it('fixes 300 equal candidate paths and six domains plus an ambiguous sample', () => {
    const { targets, profiles } = corpus();
    expect(targets).toHaveLength(300); expect(domains).toHaveLength(6); expect(samples).toHaveLength(7);
    expect(new Set(targets.map(target => target.id)).size).toBe(300);
    expect(profiles.enrich(targets).map(target => target.path)).toEqual(targets.map(target => target.path));
    for (const sample of samples) if (sample.expected !== null) expect(targets.some(target => target.id === sample.expected)).toBe(true);
  });
  it('accounts for actual requests and known versus missing token counts in both conditions', async () => {
    let requests = 0; const progress: unknown[] = [];
    // This response stub checks reporting only; no hit-rate claim is drawn from it.
    const client = { evaluate: async (batch: Parameters<typeof answer>[0]) => { requests++; return { ...answer(batch), inputTokens: requests % 2 ? 11 : null }; } };
    const report = await evaluateProfiles(client, () => requests, row => progress.push(row));
    expect(report.rows).toHaveLength(14); expect(progress).toHaveLength(14);
    expect(report.summary.map(item => item.cases)).toEqual([7, 7]);
    expect(report.summary.reduce((sum, item) => sum + item.requests, 0)).toBe(requests);
    expect(report.summary.reduce((sum, item) => sum + item.inputTokens, 0)).toBe(Math.ceil(requests / 2) * 11);
    expect(report.summary.reduce((sum, item) => sum + item.unknownTokenResponses, 0)).toBe(Math.floor(requests / 2));
    expect(requests).toBeLessThanOrEqual(MAX_REQUESTS);
    expect(JSON.stringify(report)).not.toContain(domains[0].body);
  });
});
