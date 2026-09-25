import { OrganizerError } from './errors';

export function safePath(value: string, allowRoot = false): string {
  const path = value.trim().replace(/\\/g, '/');
  if (allowRoot && path === '') return '';
  if (!path || path.startsWith('/') || [...path].some(char => char === ':' || char.charCodeAt(0) < 0x20) || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new OrganizerError('unsafe', 'error.pathInvalid');
  }
  return path;
}
export function within(path: string, folder: string): boolean { return path === folder || path.startsWith(folder + '/'); }
export function excluded(path: string, scopes: readonly string[]): boolean { return scopes.some(scope => within(path, scope)); }
export function parentPath(path: string): string { const at = path.lastIndexOf('/'); return at < 0 ? '' : path.slice(0, at); }
export function filename(path: string): string { return path.slice(path.lastIndexOf('/') + 1); }
/**
 * Where Obsidian puts new attachments for a note, when that place follows the note: `./` (same folder)
 * or `./name` (a subfolder). The vault root or a fixed folder does not follow notes, so it returns null.
 */
export function noteAttachmentFolder(setting: string, notePath: string): string | null {
  const value = setting.trim(), parent = parentPath(notePath);
  if (value === '.' || value === './') return parent;
  if (!value.startsWith('./')) return null;
  const rest = value.slice(2).replace(/\/+$/, '');
  if (!rest) return parent;
  return parent ? parent + '/' + rest : rest;
}
/** Whether a folder only holds attachments under that setting, so it is not a filing destination. */
export function isAttachmentFolder(setting: string, folder: string): boolean {
  const value = setting.trim();
  if (value.startsWith('./')) { const rest = value.slice(2).replace(/\/+$/, ''); return Boolean(rest) && (folder === rest || folder.endsWith('/' + rest)); }
  const fixed = value.replace(/^\/+|\/+$/g, '');
  return Boolean(fixed) && fixed !== '.' && within(folder, fixed);
}
export function inInbox(path: string, inbox: string, children: boolean): boolean { return Boolean(inbox) && path !== inbox && (children ? within(path, inbox) : parentPath(path) === inbox); }
export async function contentHash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
