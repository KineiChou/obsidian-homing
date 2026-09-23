import type { FolderTarget } from '../folders/types';
import { byteLength } from '../jev/request';

/** Metadata-only estimate; retries and provider framing can increase actual usage. */
export function estimateFilingRequests(targets: readonly FolderTarget[], bodyBytes: number): { min: number; max: number } {
  if (!targets.length) return { min: 0, max: 0 };
  const stateBytes = Math.max(0, bodyBytes) + 1000;
  const sizes = targets.map(target => byteLength(target) + 40);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (targets.length <= 254 && stateBytes + total < 28000) return { min: 1, max: 1 };
  const groups: number[] = []; let current = 600, count = 0;
  for (const size of sizes) {
    if (count && (count >= 64 || stateBytes + current + size > 28000)) { groups.push(current); current = 600; count = 0; }
    current += size; count++;
  }
  if (count) groups.push(current);
  let requests = 1, packed = stateBytes;
  for (const group of groups) {
    if (packed > stateBytes && packed + group > 56000) { requests++; packed = stateBytes; }
    packed += group;
  }
  const estimate = requests + 1;
  return { min: estimate, max: estimate + (stateBytes >= 28000 || groups.length > 64 ? 1 : 0) };
}
