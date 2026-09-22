import { App, FuzzySuggestModal, Modal } from 'obsidian';
import { button, node } from './dom';
import { messageFor } from '../core/errors';

export class TargetPicker<T> extends FuzzySuggestModal<T> {
  constructor(app: App, private readonly items: readonly T[], private readonly text: (item: T) => string, private readonly choose: (item: T) => void) { super(app); this.setPlaceholder('输入名称或完整路径'); }
  getItems(): T[] { return [...this.items]; }
  getItemText(item: T): string { return this.text(item); }
  onChooseItem(item: T): void { this.choose(item); }
}
export class CreateInboxModal extends Modal {
  constructor(app: App, private readonly create: (path: string) => Promise<void>) { super(app); }
  onOpen(): void {
    this.setTitle('创建收件箱');
    const label = node(this.contentEl, 'label', '知识库内的目录路径');
    const input = node(label, 'input'); input.type = 'text'; input.placeholder = 'Inbox';
    const feedback = node(this.contentEl, 'p'); feedback.setAttribute('role', 'status');
    const save = button(this.contentEl, '创建', () => { save.disabled = true; void this.create(input.value.trim()).then(() => this.close()).catch(error => { feedback.textContent = messageFor(error); save.disabled = false; }); }, true);
    input.focus();
  }
}
