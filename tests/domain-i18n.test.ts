import { afterEach, describe, expect, it } from 'vitest';
import { OrganizerError, messageFor } from '../src/core/errors';
import { safePath } from '../src/core/paths';
import { parseSettings } from '../src/settings';
import { parseChoiceResponse } from '../src/jev/response-parser';
import { errorText, setLocale, translateMessage } from '../src/i18n';
import { errorEn } from '../src/i18n/error-en';
import { errorZh } from '../src/i18n/error-zh';
import { batch } from './helpers';

afterEach(() => setLocale('en'));
describe('domain message keys', () => {
  it('keeps retry timing and message keys independent from UI locale', () => {
    const error = new OrganizerError('service', 'error.serviceUnavailable', 2500);
    expect(error.retryAfterMs).toBe(2500); expect(messageFor(error)).toBe('error.serviceUnavailable');
    setLocale('zh-CN'); expect(messageFor(error)).toBe('error.serviceUnavailable');
    expect(errorText(error)).toBe(errorZh['error.serviceUnavailable']);
    setLocale('en'); expect(errorText(error)).toBe(errorEn['error.serviceUnavailable']);
  });
  it('renders every domain key in English and migrates exact historical messages', () => {
    for (const [key, value] of Object.entries(errorEn)) {
      expect(translateMessage(key)).toBe(value);
      expect(translateMessage(errorZh[key as keyof typeof errorEn])).toBe(value);
      expect(value).not.toMatch(/\p{Script=Han}/u);
    }
    expect(translateMessage('User note 个人笔记')).toBe('User note 个人笔记');
  });
  it('preserves parameter values such as user paths', () => {
    const error = new OrganizerError('stale', 'organizer.moveTo', 0, { path: '资料/研究' });
    expect(errorText(error)).toBe('Move to 资料/研究');
    expect(messageFor(new Error('private detail'))).toBe('error.unexpected');
    expect(errorText(new Error('private detail'))).toBe(errorEn['error.unexpected']);
  });
  it('uses keys at settings, path and provider response boundaries', () => {
    for (const [operation, key] of [
      [() => parseSettings(null), 'error.settingsUnreadable'],
      [() => safePath('../outside'), 'error.pathInvalid'],
      [() => parseChoiceResponse({}, batch), 'error.responseInvalid'],
    ] as const) {
      try { operation(); expect.fail('Expected a domain error'); }
      catch (error) { expect(error).toBeInstanceOf(OrganizerError); expect(messageFor(error)).toBe(key); expect(errorText(error)).not.toMatch(/\p{Script=Han}/u); }
    }
  });
});
