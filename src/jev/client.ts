import { OrganizerError } from '../core/errors';
import { serializeBatch } from './request';
import { parseChoiceResponse } from './response-parser';
import type { ChoiceBatch, ChoiceBatchResult, DecisionClient, HttpTransport, SecretProvider } from './types';

export class JevClient implements DecisionClient {
  constructor(private readonly transport: HttpTransport, private readonly secrets: SecretProvider) {}
  async evaluate(batch: ChoiceBatch): Promise<ChoiceBatchResult> {
    const body = serializeBatch(batch);
    let secret: string | null;
    try { secret = this.secrets.get(); }
    catch { throw new OrganizerError('authentication', 'error.secretUnreadable'); }
    if (!secret?.trim()) throw new OrganizerError('authentication', 'error.secretMissing');
    let response;
    try {
      response = await this.transport.post('https://api.typesafe.ai/v1/systemone', { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body);
    } catch { throw new OrganizerError('network', 'error.network'); }
    if (response.status === 401 || response.status === 403) throw new OrganizerError('authentication', 'error.authentication');
    if (response.status === 429 || response.status >= 500) {
      const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
      const seconds = value === undefined ? NaN : Number(value);
      const retryAfter = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value ?? '') - Date.now();
      throw new OrganizerError(response.status === 429 ? 'rate-limit' : 'service', 'error.serviceUnavailable', Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 0);
    }
    if (response.status === 413 || response.status === 422) throw new OrganizerError('limit', 'error.serviceInputLimit');
    if (response.status < 200 || response.status >= 300) throw new OrganizerError('invalid-response', 'error.requestRejected');
    return parseChoiceResponse(response.json, batch);
  }
}
