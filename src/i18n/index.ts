import { en, type MessageKey } from './en';
import { zh } from './zh';

let locale: 'en' | 'zh' = 'en';
export function setLocale(language: string): void { locale = language.toLowerCase().startsWith('zh') ? 'zh' : 'en'; }
export function t(key: MessageKey, values: Readonly<Record<string, string | number>> = {}): string {
  return (locale === 'zh' ? zh[key] : en[key]).replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match));
}
export function translateMessage(message: string): string { return Object.hasOwn(en, message) ? t(message as MessageKey) : message; }
