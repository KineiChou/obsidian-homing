/** Small DOM-backed host controls, including Obsidian's non-Promise then() API. */
class Button {
  readonly buttonEl: HTMLButtonElement;
  constructor(container: HTMLElement) { this.buttonEl = container.appendChild(document.createElement('button')); }
  setButtonText(value: string): this { this.buttonEl.textContent = value; return this; }
  setCta(): this { return this; }
  setDisabled(value: boolean): this { this.buttonEl.disabled = value; return this; }
  setIcon(_value: string): this { return this; }
  setTooltip(value: string): this { this.buttonEl.setAttribute('aria-label', value); return this; }
  onClick(callback: () => unknown): this { this.buttonEl.addEventListener('click', () => { callback(); }); return this; }
}
class Input {
  readonly inputEl: HTMLInputElement;
  constructor(container: HTMLElement, type = 'text') { this.inputEl = container.appendChild(document.createElement('input')); this.inputEl.type = type; }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  getValue(): string { return this.inputEl.value; }
  onChange(callback: (value: string) => void): this { this.inputEl.addEventListener('input', () => callback(this.inputEl.value)); return this; }
}
class Toggle {
  readonly inputEl: HTMLInputElement;
  constructor(container: HTMLElement) { this.inputEl = container.appendChild(document.createElement('input')); this.inputEl.type = 'checkbox'; }
  setValue(value: boolean): this { this.inputEl.checked = value; return this; }
  onChange(callback: (value: boolean) => void): this { this.inputEl.addEventListener('change', () => callback(this.inputEl.checked)); return this; }
}
class Dropdown {
  readonly selectEl: HTMLSelectElement;
  constructor(container: HTMLElement) { this.selectEl = container.appendChild(document.createElement('select')); }
  addOption(value: string, label: string): this { const option = this.selectEl.appendChild(document.createElement('option')); option.value = value; option.textContent = label; return this; }
  setValue(value: string): this { this.selectEl.value = value; return this; }
  onChange(callback: (value: string) => void): this { this.selectEl.addEventListener('change', () => callback(this.selectEl.value)); return this; }
}
export class Setting {
  readonly settingEl: HTMLDivElement;
  readonly nameEl: HTMLDivElement;
  readonly descEl: HTMLDivElement;
  readonly controlEl: HTMLDivElement;
  constructor(container: HTMLElement) {
    this.settingEl = container.appendChild(document.createElement('div'));
    this.nameEl = this.settingEl.appendChild(document.createElement('div'));
    this.descEl = this.settingEl.appendChild(document.createElement('div'));
    this.controlEl = this.settingEl.appendChild(document.createElement('div'));
  }
  setHeading(): this { this.settingEl.classList.add('setting-item-heading'); return this; }
  setName(value: string): this { this.nameEl.textContent = value; return this; }
  setDesc(value: string): this { this.descEl.textContent = value; return this; }
  then(callback: (setting: this) => unknown): this { callback(this); return this; }
  addButton(callback: (control: Button) => unknown): this { callback(new Button(this.controlEl)); return this; }
  addExtraButton(callback: (control: Button) => unknown): this { return this.addButton(callback); }
  addText(callback: (control: Input) => unknown): this { callback(new Input(this.controlEl)); return this; }
  addTextArea(callback: (control: Input) => unknown): this { return this.addText(callback); }
  addToggle(callback: (control: Toggle) => unknown): this { callback(new Toggle(this.controlEl)); return this; }
  addDropdown(callback: (control: Dropdown) => unknown): this { callback(new Dropdown(this.controlEl)); return this; }
}
export class SecretComponent {
  constructor(_app: unknown, _container: HTMLElement) {}
  setValue(_value: string): this { return this; }
  onChange(_callback: (value: string) => void): this { return this; }
}
export class PluginSettingTab {
  readonly containerEl = document.createElement('div');
  constructor(readonly app: unknown, _plugin: unknown) {}
}
export class Modal {
  readonly contentEl = document.createElement('div');
  constructor(readonly app: unknown) {}
  setTitle(value: string): this { this.contentEl.setAttribute('aria-label', value); return this; }
  open(): void { document.body.appendChild(this.contentEl); this.onOpen(); }
  close(): void { this.onClose(); this.contentEl.remove(); }
  onClose(): void {}
  onOpen(): void {}
}
export abstract class FuzzySuggestModal<T> extends Modal {
  setPlaceholder(_value: string): void {}
  getSuggestions(query: string) { return this.getItems().filter(item => this.getItemText(item).toLowerCase().includes(query.toLowerCase())).map(item => ({ item, match: { score: 0, matches: [] } })); }
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T): void;
  onOpen(): void {
    this.contentEl.setAttribute('role', 'dialog');
    for (const item of this.getItems()) new Button(this.contentEl).setButtonText(this.getItemText(item)).onClick(() => { this.close(); this.onChooseItem(item); });
  }
}
