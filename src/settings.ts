import { OrganizerError } from './core/errors';
import { safePath } from './core/paths';

export interface FolderRule { readonly path: string; readonly purpose: string; readonly acceptsNotes: boolean; readonly subtreeRules: readonly string[] }
export interface OrganizerSettings {
  readonly inbox: string;
  readonly includeSubfolders: boolean;
  readonly secretName: string;
  readonly autoFiling: boolean;
  readonly autoLinks: boolean;
  readonly linkScope: 'vault' | 'inbox';
  readonly excludedPaths: readonly string[];
  readonly excludedDestinations: readonly string[];
  readonly folderRules: readonly FolderRule[];
  readonly dailyRequestLimit: number;
  readonly modelId: string;
}
export const DEFAULT_SETTINGS: OrganizerSettings = {
  inbox: '', includeSubfolders: true, secretName: '', autoFiling: true, autoLinks: false,
  linkScope: 'vault', excludedPaths: [], excludedDestinations: [], folderRules: [],
  dailyRequestLimit: 100, modelId: 'jev-1.13.0',
};

export function parseSettings(value: unknown): OrganizerSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrganizerError('invalid-settings', '设置无法读取，请先恢复有效的配置文件。');
  const v = value as Record<string, unknown>;
  const string = (key: string, fallback: string) => v[key] === undefined ? fallback : typeof v[key] === 'string' ? v[key] : fail();
  const boolean = (key: string, fallback: boolean) => v[key] === undefined ? fallback : typeof v[key] === 'boolean' ? v[key] : fail();
  const paths = (key: string): string[] => {
    const item = v[key] ?? [];
    if (!Array.isArray(item) || item.length > 1000 || item.some(path => typeof path !== 'string')) return fail();
    return [...new Set(item.map(path => safePath(path as string)))];
  };
  const limit = v.dailyRequestLimit ?? DEFAULT_SETTINGS.dailyRequestLimit;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 10000) return fail();
  const rules = v.folderRules ?? [];
  if (!Array.isArray(rules) || rules.length > 4096) return fail();
  const folderRules = rules.map((rule: unknown): FolderRule => {
    if (!rule || typeof rule !== 'object') return fail();
    const r = rule as Record<string, unknown>;
    if (typeof r.path !== 'string' || typeof r.purpose !== 'string' || r.purpose.length > 1000 || typeof r.acceptsNotes !== 'boolean' || !Array.isArray(r.subtreeRules) || r.subtreeRules.length > 10 || r.subtreeRules.some(s => typeof s !== 'string' || s.length > 1000)) return fail();
    return { path: safePath(r.path), purpose: r.purpose, acceptsNotes: r.acceptsNotes, subtreeRules: r.subtreeRules as string[] };
  });
  const linkScope = v.linkScope ?? 'vault';
  if (linkScope !== 'vault' && linkScope !== 'inbox') return fail();
  const modelId = string('modelId', DEFAULT_SETTINGS.modelId);
  if (modelId !== DEFAULT_SETTINGS.modelId) return fail();
  return {
    inbox: safePath(string('inbox', ''), true), secretName: string('secretName', ''),
    includeSubfolders: boolean('includeSubfolders', true), autoFiling: boolean('autoFiling', true), autoLinks: boolean('autoLinks', false),
    linkScope, excludedPaths: paths('excludedPaths'), excludedDestinations: paths('excludedDestinations'), folderRules,
    dailyRequestLimit: Number(limit), modelId,
  };
}
function fail(): never { throw new OrganizerError('invalid-settings', '设置格式无效，原始配置已保留。'); }
