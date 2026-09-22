export function node<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = parent.ownerDocument.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  parent.append(element);
  return element;
}
export function button(parent: HTMLElement, text: string, action: () => void, primary = false): HTMLButtonElement {
  const control = node(parent, 'button', text, primary ? 'mod-cta' : ''); control.type = 'button'; control.addEventListener('click', action); return control;
}
export function details(parent: HTMLElement, title: string): HTMLDetailsElement { const container = node(parent, 'details'); node(container, 'summary', title); return container; }
