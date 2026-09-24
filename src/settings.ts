import { OrganizerError } from './core/errors';
import { safePath } from './core/paths';

export type DecisionProvider = 'jev' | 'openai-compatible' | 'anthropic' | 'ollama';
export const PROVIDER_DEFAULTS = {
  jev: { endpoint: 'https://api.typesafe.ai/v1', modelId: 'jev-1.13.0', name: 'TypeSafe Jev' },
  'openai-compatible': { endpoint: 'https://api.openai.com/v1', modelId: 'gpt-4.1-mini', name: 'OpenAI compatible' },
  ollama: { endpoint: 'http://127.0.0.1:11434/v1', modelId: 'qwen3:1.7b', name: 'Ollama' },
  anthropic: { endpoint: 'https://api.anthropic.com/v1', modelId: 'claude-sonnet-4-6', name: 'Anthropic' },
} as const;
export function validateEndpoint(endpoint: string): string {
  try { const url = new URL(endpoint); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail(); return url.toString().replace(/\/$/, ''); } catch { return fail(); }
}
export interface FolderRule { readonly path: string; readonly purpose: string; readonly acceptsNotes: boolean; readonly subtreeRules: readonly string[] }
export interface OrganizerSettings {
  readonly provider: DecisionProvider;
  readonly endpoint: string;
  readonly longNoteStrategy: 'excerpt' | 'full';
  readonly folderProfilesEnabled: boolean;
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
  readonly linkHints: LinkHintStyle;
  readonly explorerMarkers: boolean;
  readonly analyzeOnOpen: boolean;
}
export type LinkHintStyle = 'underline' | 'marker' | 'off';
export const DEFAULT_SETTINGS: OrganizerSettings = {
  provider: 'jev', endpoint: PROVIDER_DEFAULTS.jev.endpoint, longNoteStrategy: 'excerpt', folderProfilesEnabled: false,
  inbox: '', includeSubfolders: true, secretName: '', autoFiling: true, autoLinks: false,
  linkScope: 'vault', excludedPaths: [], excludedDestinations: [], folderRules: [],
  dailyRequestLimit: 100, modelId: 'jev-1.13.0', linkHints: 'underline', explorerMarkers: true, analyzeOnOpen: true,
};

export function parseSettings(value: unknown): OrganizerSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrganizerError('invalid-settings', 'error.settingsUnreadable');
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
  const provider = v.provider ?? 'jev';
  if (provider !== 'jev' && provider !== 'openai-compatible' && provider !== 'anthropic' && provider !== 'ollama') return fail();
  const modelId = string('modelId', PROVIDER_DEFAULTS[provider].modelId);
  if (!modelId.trim() || modelId.length > 200 || (provider === 'jev' && modelId !== DEFAULT_SETTINGS.modelId)) return fail();
  const endpoint = validateEndpoint(string('endpoint', PROVIDER_DEFAULTS[provider].endpoint));
  if (provider === 'jev' && endpoint !== PROVIDER_DEFAULTS.jev.endpoint) return fail();
  const linkHints = v.linkHints ?? 'underline';
  if (linkHints !== 'underline' && linkHints !== 'marker' && linkHints !== 'off') return fail();
  const longNoteStrategy = v.longNoteStrategy ?? 'excerpt';
  if (longNoteStrategy !== 'excerpt' && longNoteStrategy !== 'full') return fail();
  return {
    provider, endpoint, longNoteStrategy, folderProfilesEnabled: boolean('folderProfilesEnabled', false),
    inbox: safePath(string('inbox', ''), true), secretName: string('secretName', ''),
    includeSubfolders: boolean('includeSubfolders', true), autoFiling: boolean('autoFiling', true), autoLinks: boolean('autoLinks', false),
    linkScope, excludedPaths: paths('excludedPaths'), excludedDestinations: paths('excludedDestinations'), folderRules,
    dailyRequestLimit: Number(limit), modelId, linkHints, explorerMarkers: boolean('explorerMarkers', true), analyzeOnOpen: boolean('analyzeOnOpen', true),
  };
}
function fail(): never { throw new OrganizerError('invalid-settings', 'error.settingsInvalid'); }
