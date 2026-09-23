import type { OrganizerSettings } from '../settings';

function selected(settings: OrganizerSettings, keys: readonly string[]): string {
  const values = Object.entries(settings).filter(([key]) => keys.includes(key)).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(values);
}
const provider = ['provider', 'endpoint', 'modelId'];
export function filingSettingsKey(settings: OrganizerSettings): string {
  return selected(settings, [...provider, 'inbox', 'includeSubfolders', 'excludedPaths', 'excludedDestinations', 'folderRules', 'longNoteStrategy', 'folderProfilesEnabled']);
}
export function linkSettingsKey(settings: OrganizerSettings): string {
  return selected(settings, [...provider, 'inbox', 'includeSubfolders', 'excludedPaths', 'linkScope']);
}
