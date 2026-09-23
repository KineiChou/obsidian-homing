export type ErrorCode = 'invalid-settings' | 'invalid-response' | 'authentication' | 'rate-limit' | 'service' | 'network' | 'budget' | 'cancelled' | 'timeout' | 'stale' | 'conflict' | 'storage' | 'limit' | 'missing' | 'unsafe';

export class OrganizerError extends Error {
  constructor(readonly code: ErrorCode, readonly messageKey: string, readonly retryAfterMs = 0, readonly params: Readonly<Record<string, string | number>> = {}) {
    super(messageKey);
    this.name = 'OrganizerError';
  }
}

export function messageFor(error: unknown): string {
  return error instanceof OrganizerError ? error.messageKey : 'error.unexpected';
}
