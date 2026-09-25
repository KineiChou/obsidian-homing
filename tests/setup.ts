/**
 * Obsidian runs plugins in a browser window whose DOM is augmented with helpers
 * such as `createEl`, `createDiv`, `createSpan` and `Document.win`. Provide the
 * same surface to Node and jsdom tests.
 */
type Info = string | { cls?: string | string[]; text?: string; attr?: Record<string, string> } | undefined;
type Maker = (tag: string, info?: Info, callback?: (element: HTMLElement) => void) => HTMLElement;
function apply(element: HTMLElement, info: Info): HTMLElement {
  if (typeof info === 'string') element.className = info;
  else if (info) {
    if (info.cls) element.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
    if (info.text !== undefined) element.textContent = info.text;
    for (const [name, value] of Object.entries(info.attr ?? {})) element.setAttribute(name, value);
  }
  return element;
}
export function installDomHelpers(win: Window & typeof globalThis): void {
  const define = (target: object, name: string, value: unknown) => { if (!(name in target)) Object.defineProperty(target, name, { value, configurable: true, writable: true }); };
  for (const proto of [win.HTMLElement.prototype, win.DocumentFragment.prototype]) {
    define(proto, 'createEl', function (this: HTMLElement | DocumentFragment, tag: string, info?: Info, callback?: (element: HTMLElement) => void) {
      const element = apply((this.ownerDocument ?? win.document).createElement(tag), info); this.appendChild(element); callback?.(element); return element;
    });
    define(proto, 'createDiv', function (this: { createEl: Maker }, info?: Info, callback?: (element: HTMLElement) => void) { return this.createEl('div', info, callback); });
    define(proto, 'createSpan', function (this: { createEl: Maker }, info?: Info, callback?: (element: HTMLElement) => void) { return this.createEl('span', info, callback); });
  }
  define(win, 'createEl', (tag: string, info?: Info) => apply(win.document.createElement(tag), info));
  define(win, 'createDiv', (info?: Info) => apply(win.document.createElement('div'), info));
  define(win, 'createSpan', (info?: Info) => apply(win.document.createElement('span'), info));
  if (!('win' in win.Document.prototype)) Object.defineProperty(win.Document.prototype, 'win', { get(this: Document) { return this.defaultView; }, configurable: true });
}
if (typeof globalThis.window === 'undefined') Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true });
if (typeof HTMLElement !== 'undefined') installDomHelpers(globalThis.window as Window & typeof globalThis);
