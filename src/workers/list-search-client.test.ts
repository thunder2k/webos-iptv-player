import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListSearchIndexRequest, ListSearchQueryRequest, ScopedSearchReleaseRequest } from './tasks';

const { workerMock } = vi.hoisted(() => ({
  workerMock: {
    run: vi.fn(),
    crashNextIndex: false,
    rejectNextIndex: false,
    failIndexes: false,
    // Wipes the worker's indexes before the next query, as a worker crash does.
    loseIndexes: false,
    // Outcomes for the next index tasks, in order; empty means the flags above.
    outcomes: [] as Array<'ok' | 'crash' | 'reject'>,
    // An index task waits for this gate, then reads the flags above.
    gate: null as Promise<void> | null,
    // A query task waits for this gate, then reads the flags above.
    queryGate: null as Promise<void> | null,
  },
}));

vi.mock('./app-worker-client', async () => {
  const { ScopedSearchIndex } = await import('./scoped-search-index');
  let index = new ScopedSearchIndex();
  workerMock.run.mockImplementation(async (task: string, payload: unknown) => {
    if (task === 'list-search.index') {
      if (workerMock.gate) await workerMock.gate;
      const outcome = workerMock.outcomes.shift();
      if (outcome === 'crash') throw new Error('App worker failed');
      if (outcome === 'reject') return { accepted: false };
      if (outcome === 'ok') return index.indexList(payload as ListSearchIndexRequest);
      if (workerMock.failIndexes) throw new Error('App worker failed');
      if (workerMock.crashNextIndex) {
        workerMock.crashNextIndex = false;
        index = new ScopedSearchIndex();
        throw new Error('App worker failed');
      }
      if (workerMock.rejectNextIndex) {
        workerMock.rejectNextIndex = false;
        return { accepted: false };
      }
      return index.indexList(payload as ListSearchIndexRequest);
    }
    if (task === 'list-search.query') {
      if (workerMock.queryGate) await workerMock.queryGate;
      if (workerMock.loseIndexes) {
        workerMock.loseIndexes = false;
        index = new ScopedSearchIndex();
      }
      return index.queryList(payload as ListSearchQueryRequest);
    }
    if (task === 'list-search.release') return index.releaseList(payload as ScopedSearchReleaseRequest);
    throw new Error(`Unexpected worker task: ${task}`);
  });
  return {
    runAppWorkerTask: workerMock.run,
    retainAppWorker: () => () => undefined,
  };
});

import { WorkerListSearch } from './list-search-client';
import { CONFIG } from '../config';

function diagEvents(spy: { mock: { calls: unknown[][] } }, event: string): string[] {
  return spy.mock.calls
    .map(call => call.filter(part => typeof part === 'string').join(' '))
    .filter(line => line.includes(`event=${event} `));
}

const waitOutRetryDelay = (): void => {
  vi.advanceTimersByTime(CONFIG.SEARCH.INDEX_RETRY_DELAY_MS);
};

const indexCalls = (): number =>
  workerMock.run.mock.calls.filter(([task]) => task === 'list-search.index').length;

describe('WorkerListSearch', () => {
  beforeEach(() => {
    workerMock.run.mockClear();
    workerMock.crashNextIndex = false;
    workerMock.rejectNextIndex = false;
    workerMock.failIndexes = false;
    workerMock.loseIndexes = false;
    workerMock.outcomes = [];
    workerMock.gate = null;
    workerMock.queryGate = null;
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('re-indexes after the retry delay once the worker crashed while indexing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const search = new WorkerListSearch<string>('list', 'names', name => [name]);
    const source = ['Alpha', 'Bravo'];
    workerMock.crashNextIndex = true;

    await expect(search.query(source, 'alpha')).rejects.toThrow('App worker failed');
    waitOutRetryDelay();
    await expect(search.query(source, 'bravo')).resolves.toEqual(['Bravo']);

    expect(indexCalls()).toBe(2);
    expect(diagEvents(error, 'search.worker.index.failed'))
      .toEqual([expect.stringContaining('scope=list owner=list')]);
    // The failure event covers the retry; it is not logged again.
    expect(diagEvents(warn, 'search.worker.index.missing')).toEqual([]);
  });

  it('re-indexes after the retry delay once the worker rejected the index', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const search = new WorkerListSearch<string>('list', 'names', name => [name]);
    const source = ['Alpha', 'Bravo'];
    workerMock.rejectNextIndex = true;

    await expect(search.query(source, 'alpha')).rejects.toThrow('List search index rejected');
    waitOutRetryDelay();
    await expect(search.query(source, 'bravo')).resolves.toEqual(['Bravo']);

    expect(indexCalls()).toBe(2);
    expect(diagEvents(warn, 'search.worker.index.rejected')).toHaveLength(1);
    expect(diagEvents(warn, 'search.worker.index.missing')).toEqual([]);
  });

  it('re-indexes once after concurrent queries shared a failed attempt', async () => {
    const search = new WorkerListSearch<string>('list', 'names', name => [name]);
    const source = ['Alpha', 'Bravo'];
    let open!: () => void;
    workerMock.gate = new Promise(resolve => { open = resolve; });
    workerMock.crashNextIndex = true;

    const first = search.query(source, 'alpha');
    const second = search.query(source, 'bravo');
    open();
    workerMock.gate = null;
    await expect(first).rejects.toThrow('App worker failed');
    await expect(second).rejects.toThrow('App worker failed');
    expect(indexCalls()).toBe(1);

    waitOutRetryDelay();
    await expect(Promise.all([search.query(source, 'alpha'), search.query(source, 'bravo')]))
      .resolves.toEqual([['Alpha'], ['Bravo']]);
    expect(indexCalls()).toBe(2);
  });

  it('keeps the index of a newer session when an attempt released mid-way fails', async () => {
    const search = new WorkerListSearch<string>('list', 'names', name => [name]);
    const source = ['Alpha', 'Bravo'];
    let open!: () => void;
    workerMock.gate = new Promise(resolve => { open = resolve; });
    workerMock.crashNextIndex = true;

    const released = search.query(source, 'alpha');
    search.release();
    const current = search.query(source, 'bravo');
    open();
    workerMock.gate = null;
    await expect(released).rejects.toThrow('App worker failed');
    await expect(current).resolves.toEqual(['Bravo']);
    // The released attempt's failure must not drop the newer session's index.
    await expect(search.query(source, 'alpha')).resolves.toEqual(['Alpha']);
    expect(indexCalls()).toBe(2);
  });

  it('does not re-index the list of a query a newer list superseded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const search = new WorkerListSearch<string>('list', 'names', name => [name]);
    const alpha = ['Alpha'];
    await expect(search.query(alpha, 'alpha')).resolves.toEqual(['Alpha']);
    let openQuery!: () => void;
    workerMock.queryGate = new Promise(resolve => { openQuery = resolve; });
    const queries = (): number => workerMock.run.mock.calls.filter(([task]) => task === 'list-search.query').length;

    const older = search.query(alpha, 'alph');
    await vi.waitFor(() => expect(queries()).toBe(2));
    workerMock.queryGate = null;
    let openIndex!: () => void;
    workerMock.gate = new Promise(resolve => { openIndex = resolve; });
    // A newer query switches lists while the older one waits on the worker.
    const newer = search.query(['Bravo'], 'bravo');
    await vi.waitFor(() => expect(indexCalls()).toBe(2));
    // The worker crashed, so the older query finds no index.
    workerMock.loseIndexes = true;
    openQuery();
    const olderOutcome = older.then(() => 'resolved', (failure: Error) => failure.message);
    await new Promise(resolve => setTimeout(resolve, 0));
    workerMock.gate = null;
    openIndex();

    await expect(newer).resolves.toEqual(['Bravo']);
    await expect(olderOutcome).resolves.toBe('List search query superseded: list');
    expect(indexCalls()).toBe(2);
    expect(diagEvents(warn, 'search.worker.index.missing')).toEqual([]);
    expect(diagEvents(error, 'search.worker.recovery.failed')).toEqual([]);
  });

  it('falls back without re-indexing until the retry delay passes', async () => {
    const search = new WorkerListSearch<string>('list', 'names', name => [name]);
    const source = ['Alpha', 'Bravo'];
    workerMock.failIndexes = true;

    await expect(search.query(source, 'alpha')).rejects.toThrow('App worker failed');
    await expect(search.query(source, 'alph')).rejects.toThrow('List search index retry pending');
    vi.advanceTimersByTime(CONFIG.SEARCH.INDEX_RETRY_DELAY_MS - 1);
    await expect(search.query(source, 'al')).rejects.toThrow('List search index retry pending');
    expect(indexCalls()).toBe(1);

    workerMock.failIndexes = false;
    // The delay is per list: a new list indexes at once.
    await expect(search.query(['Charlie'], 'charlie')).resolves.toEqual(['Charlie']);
    expect(indexCalls()).toBe(2);
  });

  it('logs a failing worker once until an index attempt succeeds', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const search = new WorkerListSearch<string>('list', 'names', name => [name]);
    const source = ['Alpha', 'Bravo'];
    workerMock.failIndexes = true;

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(search.query(source, 'alpha')).rejects.toThrow('App worker failed');
      waitOutRetryDelay();
    }
    expect(indexCalls()).toBe(3);
    expect(diagEvents(error, 'search.worker.index.failed')).toHaveLength(1);

    workerMock.failIndexes = false;
    await expect(search.query(source, 'alpha')).resolves.toEqual(['Alpha']);
    workerMock.failIndexes = true;
    await expect(search.query(['Charlie'], 'charlie')).rejects.toThrow('App worker failed');
    expect(diagEvents(error, 'search.worker.index.failed')).toHaveLength(2);
  });

  it('logs a failure on the same list again after an attempt succeeded', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const search = new WorkerListSearch<string>('list', 'names', name => [name]);
    const source = ['Alpha', 'Bravo'];
    workerMock.failIndexes = true;
    await expect(search.query(source, 'alpha')).rejects.toThrow('App worker failed');

    workerMock.failIndexes = false;
    waitOutRetryDelay();
    await expect(search.query(source, 'alpha')).resolves.toEqual(['Alpha']);

    workerMock.loseIndexes = true;
    workerMock.failIndexes = true;
    await expect(search.query(source, 'bravo')).rejects.toThrow('App worker failed');
    expect(indexCalls()).toBe(3);
    expect(diagEvents(error, 'search.worker.index.failed')).toHaveLength(2);
  });

  it('keeps the retry delay when re-indexing a lost index fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const search = new WorkerListSearch<string>('list', 'names', name => [name]);
    const source = ['Alpha', 'Bravo'];
    await expect(search.query(source, 'alpha')).resolves.toEqual(['Alpha']);

    workerMock.loseIndexes = true;
    workerMock.failIndexes = true;
    await expect(search.query(source, 'alph')).rejects.toThrow('App worker failed');
    await expect(search.query(source, 'al')).rejects.toThrow('List search index retry pending');
    await expect(search.query(source, 'a')).rejects.toThrow('List search index retry pending');
    expect(indexCalls()).toBe(2);
    expect(diagEvents(warn, 'search.worker.index.missing')).toHaveLength(1);
    expect(diagEvents(error, 'search.worker.index.failed')).toHaveLength(1);

    workerMock.failIndexes = false;
    waitOutRetryDelay();
    await expect(search.query(source, 'alpha')).resolves.toEqual(['Alpha']);
    expect(indexCalls()).toBe(3);
  });

  it('logs the current failure when a released attempt fails first', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const search = new WorkerListSearch<string>('list', 'names', name => [name]);
    const source = ['Alpha', 'Bravo'];
    let open!: () => void;
    workerMock.gate = new Promise(resolve => { open = resolve; });
    workerMock.outcomes = ['ok', 'crash'];

    const released = search.query(source, 'alpha');
    search.release();
    const current = search.query(source, 'bravo');
    open();
    workerMock.gate = null;
    await expect(released).rejects.toThrow('List search index rejected');
    await expect(current).rejects.toThrow('App worker failed');

    expect(diagEvents(warn, 'search.worker.index.rejected')).toEqual([]);
    expect(diagEvents(error, 'search.worker.index.failed')).toHaveLength(1);
  });

  it('logs a failure again once the list changes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const search = new WorkerListSearch<string>('list', 'names', name => [name]);
    const bravo = ['Bravo'];
    workerMock.failIndexes = true;

    await expect(search.query(['Alpha'], 'alpha')).rejects.toThrow('App worker failed');
    await expect(search.query(bravo, 'bravo')).rejects.toThrow('App worker failed');
    search.release();
    await expect(search.query(bravo, 'bravo')).rejects.toThrow('App worker failed');
    expect(diagEvents(error, 'search.worker.index.failed')).toHaveLength(3);
  });

  it('times the retry delay on a clock the wall clock cannot move', async () => {
    const search = new WorkerListSearch<string>('list', 'names', name => [name]);
    const source = ['Alpha', 'Bravo'];
    workerMock.crashNextIndex = true;

    await expect(search.query(source, 'alpha')).rejects.toThrow('App worker failed');
    // The TV sets its clock back an hour.
    vi.setSystemTime(Date.now() - 60 * 60 * 1000);
    waitOutRetryDelay();
    await expect(search.query(source, 'alpha')).resolves.toEqual(['Alpha']);
    expect(indexCalls()).toBe(2);
  });
});
