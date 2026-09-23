import { OrganizerError } from './errors';

export function safePath(value: string, allowRoot = false): string {
  const path = value.trim().replace(/\\/g, '/');
  if (allowRoot && path === '') return '';
  if (!path || path.startsWith('/') || /[\u0000-\u001f:]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new OrganizerError('unsafe', 'error.pathInvalid');
  }
  return path;
}
export function within(path: string, folder: string): boolean { return path === folder || path.startsWith(folder + '/'); }
export function excluded(path: string, scopes: readonly string[]): boolean { return scopes.some(scope => within(path, scope)); }
export function parentPath(path: string): string { const at = path.lastIndexOf('/'); return at < 0 ? '' : path.slice(0, at); }
export function filename(path: string): string { return path.slice(path.lastIndexOf('/') + 1); }
export function inInbox(path: string, inbox: string, children: boolean): boolean { return Boolean(inbox) && path !== inbox && (children ? within(path, inbox) : parentPath(path) === inbox); }
export async function contentHash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
