import type { OrganizerSettings } from '../settings';

function selected(settings: OrganizerSettings, keys: readonly string[]): string {
  const values = Object.entries(settings).filter(([key]) => keys.includes(key) && (key !== 'endpoint' || settings.provider !== 'jev')).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    if (key === 'excludedPaths' || key === 'excludedDestinations') return [key, [...value as readonly string[]].sort()];
    if (key === 'folderRules') return [key, [...settings.folderRules].sort((a, b) => a.path.localeCompare(b.path))];
    return [key, value];
  });
  return JSON.stringify(values);
}
const provider = ['provider', 'endpoint', 'modelId'];
export function filingSettingsKey(settings: OrganizerSettings): string {
  return selected(settings, [...provider, 'inbox', 'includeSubfolders', 'excludedPaths', 'excludedDestinations', 'folderRules', 'longNoteStrategy', 'folderProfilesEnabled']);
}
export function linkSettingsKey(settings: OrganizerSettings): string {
  return selected(settings, [...provider, ...(settings.linkScope === 'inbox' ? ['inbox', 'includeSubfolders'] : []), 'excludedPaths', 'linkScope']);
}
