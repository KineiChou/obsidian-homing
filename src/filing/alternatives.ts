import type { FilingProposal } from './types';

/** Ranked targets whose probability is within this distance of the first count as close alternatives. */
export const CLOSE_GAP = 0.2;
/** Close alternatives need real probabilities; a ranking-only answer says nothing about how close they are. */
export function closeAlternatives(proposal: FilingProposal | undefined): readonly { readonly targetId: string; readonly probability: number }[] {
  const ranked = proposal?.ranked ?? [];
  if (!proposal || proposal.rankOnly || ranked.length < 2) return [];
  return ranked.slice(1).filter(item => ranked[0]!.probability - item.probability < CLOSE_GAP);
}
