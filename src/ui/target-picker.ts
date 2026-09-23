import { App, FuzzySuggestModal, Modal, type FuzzyMatch } from 'obsidian';
import { button, node } from './dom';
import { safePath, within } from '../core/paths';
import type { FolderTarget } from '../folders/types';
import type { OrganizerController } from './types';
import { errorText, t } from '../i18n';

export class TargetPicker<T> extends FuzzySuggestModal<T> {
  constructor(app: App, private readonly items: readonly T[], private readonly text: (item: T) => string, private readonly choose: (item: T) => void) { super(app); this.setPlaceholder(t('picker.placeholder')); }
  getItems(): T[] { return [...this.items]; }
  getItemText(item: T): string { return this.text(item); }
  onChooseItem(item: T): void { this.choose(item); }
}
type Destination = { folder: FolderTarget } | { createPath: string };
export class DestinationPicker extends FuzzySuggestModal<Destination> {
  constructor(app: App, private readonly controller: OrganizerController, private readonly choose: (id: string) => void) { super(app); this.setPlaceholder(t('picker.placeholder')); }
  getItems(): Destination[] { return this.controller.folders().map(folder => ({ folder })); }
  getItemText(item: Destination): string { return 'folder' in item ? item.folder.path : t('picker.create', { path: item.createPath }); }
  getSuggestions(query: string): FuzzyMatch<Destination>[] {
    const matches = super.getSuggestions(query); if (matches.length || !query.trim()) return matches;
    try {
      const path = safePath(query.trim()), settings = this.controller.settings();
      if (within(path, settings.inbox) || [...settings.excludedPaths, ...settings.excludedDestinations].some(excluded => within(path, excluded)) || this.controller.allFolders().includes(path)) return [];
      return [{ item: { createPath: path }, match: { score: 0, matches: [] } }];
    } catch { return []; }
  }
  onChooseItem(item: Destination): void {
    if ('folder' in item) { this.choose(item.folder.id); return; }
    new CreateFolderModal(this.app, t('picker.createTitle'), item.createPath, async path => { const target = await this.controller.createDestination(path); this.choose(target.id); }).open();
  }
}
class CreateFolderModal extends Modal {
  constructor(app: App, private readonly title: string, private readonly path: string, private readonly create: (path: string) => Promise<void>) { super(app); }
  onOpen(): void {
    this.setTitle(this.title);
    const label = node(this.contentEl, 'label', t('picker.path'));
    const input = node(label, 'input'); input.type = 'text'; input.placeholder = 'Inbox'; input.value = this.path;
    const feedback = node(this.contentEl, 'p'); feedback.setAttribute('role', 'status');
    const footer = node(this.contentEl, 'div', undefined, 'note-organizer-actions');
    const save = button(footer, t('picker.confirmCreate'), () => { save.disabled = true; void this.create(input.value.trim()).then(() => this.close()).catch(error => { feedback.textContent = errorText(error); save.disabled = false; }); }, true);
    button(footer, t('batch.cancel'), () => this.close());
    input.focus();
  }
}
export class CreateInboxModal extends CreateFolderModal {
  constructor(app: App, create: (path: string) => Promise<void>) { super(app, t('picker.createInbox'), '', create); }
}
