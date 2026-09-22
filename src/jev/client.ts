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
    catch { throw new OrganizerError('authentication', '无法读取 API 密钥，请重新选择凭据。'); }
    if (!secret?.trim()) throw new OrganizerError('authentication', '请先选择有效的 API 密钥。');
    let response;
    try {
      response = await this.transport.post('https://api.typesafe.ai/v1/systemone', { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body);
    } catch { throw new OrganizerError('network', '无法连接分析服务，请检查网络后重试。'); }
    if (response.status === 401 || response.status === 403) throw new OrganizerError('authentication', 'API 密钥无效或没有所选模型的访问权限。');
    if (response.status === 429 || response.status >= 500) {
      const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
      const seconds = value === undefined ? NaN : Number(value);
      const retryAfter = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value ?? '') - Date.now();
      throw new OrganizerError(response.status === 429 ? 'rate-limit' : 'service', '分析服务暂不可用，请稍后重试。', Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 0);
    }
    if (response.status === 413 || response.status === 422) throw new OrganizerError('limit', '服务无法处理本次输入，请缩小范围或手动处理。');
    if (response.status < 200 || response.status >= 300) throw new OrganizerError('invalid-response', '分析请求未被服务接受，请检查模型设置。');
    return parseChoiceResponse(response.json, batch);
  }
}
