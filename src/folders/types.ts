import type { OrganizerSettings } from '../settings';
export interface FolderTarget { readonly id: string; readonly path: string; readonly directPurpose: string; readonly effectiveRules: readonly string[] }
export interface FolderSnapshot { readonly revision: number; readonly targets: readonly FolderTarget[] }
export interface FolderCatalog {
  refresh(paths: readonly string[], settings: OrganizerSettings): void;
  snapshot(): FolderSnapshot;
  get(id: string): FolderTarget | undefined;
}
