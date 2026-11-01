// A worker index attempt failed recently, so the caller ranks on the main
// thread until the retry delay passes; its failure was already logged.
export class IndexRetryPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexRetryPendingError';
  }
}

export function isIndexRetryPending(error: unknown): boolean {
  return error instanceof Error && error.name === 'IndexRetryPendingError';
}
