import { OrganizerError, messageFor } from '../core/errors';
import { en, type MessageKey } from './en';
import { zh } from './zh';
import { errorEn, type ErrorMessageKey } from './error-en';
import { errorZh } from './error-zh';

let locale: 'en' | 'zh' = 'en';
export function setLocale(language: string): void { locale = language.toLowerCase().startsWith('zh') ? 'zh' : 'en'; }
function interpolate(message: string, values: Readonly<Record<string, string | number>>): string {
  return message.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match));
}
export function t(key: MessageKey, values: Readonly<Record<string, string | number>> = {}): string {
  return interpolate(locale === 'zh' ? zh[key] : en[key], values);
}
// Exact historical message migration for records saved before message keys were introduced.
const historicalKeys = new Map(Object.entries(errorZh).map(([key, value]) => [value, key as ErrorMessageKey]));
export function translateMessage(raw: string, values: Readonly<Record<string, string | number>> = {}): string {
  const key = historicalKeys.get(raw) ?? raw;
  if (Object.hasOwn(errorEn, key)) return interpolate((locale === 'zh' ? errorZh : errorEn)[key as ErrorMessageKey], values);
  return Object.hasOwn(en, key) ? t(key as MessageKey, values) : raw;
}
export function errorText(error: unknown): string {
  return translateMessage(messageFor(error), error instanceof OrganizerError ? error.params : {});
}
