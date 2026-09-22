export type ErrorCode = 'invalid-settings' | 'invalid-response' | 'authentication' | 'rate-limit' | 'service' | 'network' | 'budget' | 'cancelled' | 'timeout' | 'stale' | 'conflict' | 'storage' | 'limit' | 'missing' | 'unsafe';

export class OrganizerError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly retryAfterMs = 0) {
    super(message);
    this.name = 'OrganizerError';
  }
}

export function messageFor(error: unknown): string {
  return error instanceof OrganizerError ? error.message : '操作暂未完成，请重试。';
}
