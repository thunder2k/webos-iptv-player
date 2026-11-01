import { retainAppWorker, runAppWorkerTask } from './app-worker-client';
import type { ListSearchIndexRequest } from './tasks';
import { createLogger } from '../utils/logger';
import { CONFIG } from '../config';
import { IndexRetryPendingError } from './index-retry';

const log = createLogger('ListSearchWorker');

export class WorkerListSearch<T> {
  private sessionId = 0;
  private source: T[] | null = null;
  private indexPromise: Promise<boolean> | null = null;
  private releaseWorker: (() => void) | null = null;
  private retryAt = 0;
  // Failures repeat until an attempt succeeds; only the first is logged.
  private failureLogged = false;

  constructor(
    private readonly owner: string,
    private readonly mode: ListSearchIndexRequest['mode'],
    private readonly fields: (item: T) => string[],
  ) {}

  async query(source: T[], query: string): Promise<T[]> {
    const indexed = await this.ensureIndex(source);
    let result = await this.runQuery(query);
    if (!result && source !== this.source) {
      // A newer query switched lists, or a release dropped this one: indexing
      // this list again would replace the newer index and fail that query.
      throw new Error(`List search query superseded: ${this.owner}`);
    }
    if (!result) {
      log.warn(
        'List search index missing; rebuilding',
        'event=search.worker.index.missing',
        'scope=list',
        `owner=${this.owner}`,
        `session=${String(this.sessionId)}`,
      );
      // Rebuild as a fresh attempt, so a worker that keeps failing gets the
      // retry delay rather than the whole list on every query.
      if (this.indexPromise === indexed.attempt) this.indexPromise = null;
      await this.ensureIndex(source);
      result = await this.runQuery(query);
      if (result) {
        log.info(
          'List search index recovery completed',
          'event=search.worker.recovery.completed',
          'scope=list',
          `owner=${this.owner}`,
          `session=${String(this.sessionId)}`,
        );
      }
    }
    if (!result) {
      log.error(
        'List search index recovery failed',
        'event=search.worker.recovery.failed',
        'scope=list',
        `owner=${this.owner}`,
        `session=${String(this.sessionId)}`,
      );
      throw new Error(`List search index unavailable: ${this.owner}`);
    }
    return result.indices.map(index => source[index]).filter(item => item !== undefined);
  }

  release(): void {
    const releasedSession = this.source ? this.sessionId : null;
    this.sessionId++;
    this.source = null;
    this.indexPromise = null;
    this.retryAt = 0;
    this.failureLogged = false;
    if (releasedSession !== null) void this.releaseIndex(releasedSession);
    this.releaseWorker?.();
    this.releaseWorker = null;
  }

  private async ensureIndex(source: T[]): Promise<{ attempt: Promise<boolean> }> {
    if (source !== this.source) {
      this.sessionId++;
      this.source = source;
      this.retryAt = 0;
      this.failureLogged = false;
      this.indexPromise = this.index(source);
    } else if (!this.indexPromise) {
      // Each attempt posts the whole list, so a failing worker is not retried on every query.
      if (performance.now() < this.retryAt) {
        throw new IndexRetryPendingError(`List search index retry pending: ${this.owner}`);
      }
      this.indexPromise = this.index(source);
    }
    if (!this.releaseWorker) this.releaseWorker = retainAppWorker();
    const pending = this.indexPromise;
    let accepted = false;
    let threw = false;
    let failure: unknown;
    try {
      accepted = await pending;
    } catch (error) {
      threw = true;
      failure = error;
    }
    if (accepted) return { attempt: pending };
    const error = threw ? failure : new Error(`List search index rejected: ${this.owner}`);
    // A released or replaced attempt, or one a sharing query already handled:
    // its failure must not take the current attempt's log.
    if (pending !== this.indexPromise) throw error;
    // A failed attempt is forgotten, so a query after the delay indexes again.
    this.indexPromise = null;
    this.retryAt = performance.now() + CONFIG.SEARCH.INDEX_RETRY_DELAY_MS;
    if (!this.failureLogged) {
      this.failureLogged = true;
      if (threw) {
        log.error(
          'List search indexing failed',
          'event=search.worker.index.failed',
          'scope=list',
          `owner=${this.owner}`,
          `session=${String(this.sessionId)}`,
          failure,
        );
      } else {
        log.warn(
          'List search index rejected',
          'event=search.worker.index.rejected',
          'scope=list',
          `owner=${this.owner}`,
          `session=${String(this.sessionId)}`,
        );
      }
    }
    throw error;
  }

  private async index(source: T[]): Promise<boolean> {
    const sessionId = this.sessionId;
    const response = await runAppWorkerTask('list-search.index', {
      owner: this.owner,
      sessionId,
      mode: this.mode,
      documents: source.map(item => this.fields(item)),
    });
    const accepted = response.accepted && sessionId === this.sessionId;
    if (accepted) {
      this.failureLogged = false;
      log.info(
        'List search index ready',
        'event=search.worker.index.ready',
        'scope=list',
        `owner=${this.owner}`,
        `session=${String(sessionId)}`,
        `documents=${String(source.length)}`,
      );
    }
    return accepted;
  }

  private async runQuery(query: string) {
    try {
      return await runAppWorkerTask('list-search.query', {
        owner: this.owner,
        sessionId: this.sessionId,
        query,
      });
    } catch (error) {
      log.error(
        'List search query failed',
        'event=search.worker.query.failed',
        'scope=list',
        `owner=${this.owner}`,
        `session=${String(this.sessionId)}`,
        error,
      );
      throw error;
    }
  }

  private async releaseIndex(sessionId: number): Promise<void> {
    try {
      const response = await runAppWorkerTask('list-search.release', {
        owner: this.owner,
        sessionId,
      });
      if (!response.accepted) return;
      log.debug(
        'List search index released',
        'event=search.worker.index.released',
        'scope=list',
        `owner=${this.owner}`,
        `session=${String(sessionId)}`,
      );
    } catch (error) {
      log.warn(
        'List search index release failed',
        'event=search.worker.index.release.failed',
        'scope=list',
        `owner=${this.owner}`,
        `session=${String(sessionId)}`,
        error,
      );
    }
  }
}
