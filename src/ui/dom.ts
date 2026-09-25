export function node<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  // Obsidian's DOM helper keeps elements in the right window for popouts.
  const element = parent.createEl(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
export function button(parent: HTMLElement, text: string, action: () => void, primary = false): HTMLButtonElement {
  const control = node(parent, 'button', text, primary ? 'mod-cta' : ''); control.type = 'button'; control.addEventListener('click', action); return control;
}
export function details(parent: HTMLElement, title: string): HTMLDetailsElement { const container = node(parent, 'details'); node(container, 'summary', title); return container; }
