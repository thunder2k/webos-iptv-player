import { describe, expect, it, vi } from 'vitest';
import type { Channel } from '../types';

const refs = vi.hoisted(() => new WeakMap<object, unknown>());
vi.mock('../services/idb-cache', () => ({
  cacheRecordRef: (value: object) => refs.get(value) ?? null,
}));

import {
  cachedChannelsRequest,
  cachedNamesRequest,
  ProgrammeRuns,
  sampleDocuments,
  selectCatalogItems,
} from './search-cache-source';

function channel(name: string, group: string, extra: Partial<Channel> = {}): Channel {
  return { id: name, name, group, url: 'http://host/a', ...extra } as Channel;
}

const RECORD = { store: 'playlist-cache' as const, key: 'k', timestamp: 1 };

describe('search cache sources', () => {
  it('samples evenly spaced documents, first and last included', () => {
    expect(sampleDocuments(3, index => [String(index)]).indices).toEqual([0, 1, 2]);
    expect(sampleDocuments(100, index => [String(index)]).indices)
      .toEqual([0, 14, 28, 42, 57, 71, 85, 99]);
    expect(sampleDocuments(0, () => [])).toEqual({ indices: [], documents: [] });
  });

  it('sends only customized channels as overrides', () => {
    const channels = [
      channel('Alpha', 'News'),
      channel('Delta', 'News', { sourceName: 'Bravo' }),
      channel('Charlie', 'Favorites', { sourceGroup: 'Movies' }),
    ];
    const request = cachedChannelsRequest(channels, {
      record: RECORD,
      length: 4,
      selection: new Uint32Array([0, 1, 3]),
    });
    expect(request).toMatchObject({
      record: RECORD,
      length: 4,
      overrideIndices: [1, 2],
      overrides: [['Delta', 'News', 'Bravo'], ['Charlie', 'Favorites', '']],
    });
    expect(cachedChannelsRequest(channels, null)).toBeNull();
    expect(cachedChannelsRequest(channels, {
      record: RECORD,
      length: 4,
      selection: new Uint32Array([0, 1]),
    })).toBeNull();
  });

  it('skips concealment checks when nothing is concealed', () => {
    const items = [{ name: 'Alpha' }, { name: 'Bravo' }, { name: 'Charlie' }];
    const concealed = vi.fn((item: { name: string }) => item.name === 'Bravo');

    const open = selectCatalogItems(items, false, concealed);
    expect(open).toEqual({ items, selection: null });
    expect(open.items).toBe(items);
    expect(concealed).not.toHaveBeenCalled();

    const visible = selectCatalogItems(items, true, concealed);
    expect(visible.items.map(item => item.name)).toEqual(['Alpha', 'Charlie']);
    expect(visible.selection).toEqual(new Uint32Array([0, 2]));
  });

  it('maps catalog names only for a remembered cache record', () => {
    const items = [{ name: 'Alpha' }, { name: 'Bravo' }];
    expect(cachedNamesRequest(items, items, null)).toBeNull();

    const ref = { store: 'catalog-cache', key: 'a|vod_all', timestamp: 2 };
    refs.set(items, ref);
    expect(cachedNamesRequest(items, items, null)).toMatchObject({
      record: ref,
      length: 2,
      selection: null,
      samples: { indices: [0, 1], documents: [['Alpha'], ['Bravo']] },
    });
    const selection = new Uint32Array([1]);
    expect(cachedNamesRequest(items, [items[1]], selection)?.selection).toBe(selection);
    expect(cachedNamesRequest(items, items, selection)).toBeNull();

    refs.set(items, RECORD);
    expect(cachedNamesRequest(items, items, null)).toBeNull();
  });

  it('builds programme runs only when every run is cached consistently', () => {
    const origin = { url: 'http://host/epg', id: 'e1', timestamp: 3 };
    const samples = sampleDocuments(0, () => []);
    const runs = new ProgrammeRuns();
    runs.add(0, origin, 2);
    runs.add(2, { ...origin, id: 'e2' }, 1);
    expect(runs.request(samples)).toEqual({
      records: [{ store: 'epg-cache', key: 'http://host/epg', timestamp: 3 }],
      runChannels: new Uint32Array([0, 2]),
      runRecords: new Uint32Array([0, 0]),
      runIds: ['e1', 'e2'],
      runCounts: new Uint32Array([2, 1]),
      samples,
    });

    const uncached = new ProgrammeRuns();
    uncached.add(0, origin, 2);
    uncached.add(1, null, 1);
    expect(uncached.request(samples)).toBeNull();

    const mixed = new ProgrammeRuns();
    mixed.add(0, origin, 2);
    mixed.add(1, { ...origin, timestamp: 4 }, 1);
    expect(mixed.request(samples)).toBeNull();
  });
});
