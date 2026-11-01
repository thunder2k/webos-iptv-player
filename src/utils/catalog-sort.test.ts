import { describe, it, expect } from 'vitest';
import {
  CATALOG_SORT_OPTIONS,
  defaultSortDirection,
  isCatalogSort,
  isCatalogSortDirection,
  sortCatalogItems,
  type CatalogSortItem,
} from './catalog-sort';

interface Item extends CatalogSortItem {
  id: string;
}

const item = (id: string, over: Partial<CatalogSortItem> = {}): Item => ({
  id, name: id, rating: '', ...over,
});
const ids = (items: Item[]): string[] => items.map(entry => entry.id);

describe('catalog sort options', () => {
  it('lists default, name, added, rating, and year', () => {
    expect(CATALOG_SORT_OPTIONS).toEqual(['default', 'name', 'added', 'rating', 'year']);
  });

  it('starts name ascending and added, rating, and year descending', () => {
    expect(defaultSortDirection('default')).toBe('asc');
    expect(defaultSortDirection('name')).toBe('asc');
    expect(defaultSortDirection('added')).toBe('desc');
    expect(defaultSortDirection('rating')).toBe('desc');
    expect(defaultSortDirection('year')).toBe('desc');
  });

  it('validates sort fields and directions', () => {
    for (const option of CATALOG_SORT_OPTIONS) expect(isCatalogSort(option)).toBe(true);
    for (const value of ['', 'Name', 'popularity', null, undefined, 1, {}]) {
      expect(isCatalogSort(value)).toBe(false);
    }
    expect(isCatalogSortDirection('asc')).toBe(true);
    expect(isCatalogSortDirection('desc')).toBe(true);
    for (const value of ['ASC', 'up', '', null, 1]) {
      expect(isCatalogSortDirection(value)).toBe(false);
    }
  });
});

describe('sortCatalogItems', () => {
  it('keeps server order for default in a new array', () => {
    const items = [item('b'), item('a')];
    const sorted = sortCatalogItems(items, 'default', 'en');
    expect(ids(sorted)).toEqual(['b', 'a']);
    expect(sorted).not.toBe(items);
    expect(ids(sortCatalogItems(items, 'default', 'en', 'desc'))).toEqual(['b', 'a']);
  });

  it('never mutates the input array', () => {
    const items = [item('c', { rating: '1' }), item('a', { rating: '3' }), item('b', { rating: '2' })];
    const snapshot = items.slice();
    for (const sort of CATALOG_SORT_OPTIONS) {
      sortCatalogItems(items, sort, 'en', 'asc');
      sortCatalogItems(items, sort, 'en', 'desc');
    }
    expect(items).toEqual(snapshot);
    expect(items.every((entry, index) => entry === snapshot[index])).toBe(true);
  });

  it('sorts names naturally, ignoring case, accents, and surrounding space', () => {
    const items = [
      item('10', { name: 'Movie 10' }),
      item('2', { name: 'movie 2' }),
      item('e', { name: '  Éclair' }),
      item('a', { name: 'apple' }),
      item('z', { name: 'Zulu' }),
    ];
    expect(ids(sortCatalogItems(items, 'name', 'en'))).toEqual(['a', 'e', '2', '10', 'z']);
    expect(ids(sortCatalogItems(items, 'name', 'en', 'desc'))).toEqual(['z', '10', '2', 'e', 'a']);
  });

  it('uses the given locale for name collation', () => {
    const items = [item('z', { name: 'z' }), item('ae', { name: 'ä' })];
    expect(ids(sortCatalogItems(items, 'name', 'de'))).toEqual(['ae', 'z']);
    expect(ids(sortCatalogItems(items, 'name', 'sv'))).toEqual(['z', 'ae']);
    expect(ids(sortCatalogItems(items, 'name', 'en-XA'))).toEqual(['ae', 'z']);
  });

  it('places blank names last in both directions', () => {
    const items = [
      item('blank', { name: '   ' }),
      item('b', { name: 'B' }),
      item('empty', { name: '' }),
      item('a', { name: 'A' }),
    ];
    expect(ids(sortCatalogItems(items, 'name', 'en'))).toEqual(['a', 'b', 'blank', 'empty']);
    expect(ids(sortCatalogItems(items, 'name', 'en', 'desc'))).toEqual(['b', 'a', 'blank', 'empty']);
  });

  it('sorts added time newest first by default and oldest first ascending', () => {
    const items = [
      item('old', { addedAt: 1000 }),
      item('none'),
      item('new', { addedAt: 3000 }),
      item('mid', { addedAt: 2000 }),
    ];
    expect(ids(sortCatalogItems(items, 'added', 'en'))).toEqual(['new', 'mid', 'old', 'none']);
    expect(ids(sortCatalogItems(items, 'added', 'en', 'asc'))).toEqual(['old', 'mid', 'new', 'none']);
  });

  it('sorts ratings numerically, keeping zero as a rating and missing ones last', () => {
    const items = [
      item('nine', { rating: '9' }),
      item('blank', { rating: '' }),
      item('ten', { rating: ' 10 ' }),
      item('zero', { rating: '0' }),
      item('na', { rating: 'N/A' }),
      item('frac', { rating: '7.5' }),
      item('neg', { rating: '-1' }),
    ];
    expect(ids(sortCatalogItems(items, 'rating', 'en')))
      .toEqual(['ten', 'nine', 'frac', 'zero', 'blank', 'na', 'neg']);
    expect(ids(sortCatalogItems(items, 'rating', 'en', 'asc')))
      .toEqual(['zero', 'frac', 'nine', 'ten', 'blank', 'na', 'neg']);
  });

  it('sorts years and places missing or invalid years last in both directions', () => {
    const items = [
      item('y2000', { year: 2000 }),
      item('zero', { year: 0 }),
      item('y2020', { year: 2020 }),
      item('nan', { year: NaN }),
      item('none'),
      item('str', { year: '2010' as unknown as number }),
      item('obj', { year: {} as unknown as number }),
    ];
    expect(ids(sortCatalogItems(items, 'year', 'en')))
      .toEqual(['y2020', 'str', 'y2000', 'zero', 'nan', 'none', 'obj']);
    expect(ids(sortCatalogItems(items, 'year', 'en', 'asc')))
      .toEqual(['y2000', 'str', 'y2020', 'zero', 'nan', 'none', 'obj']);
  });

  it('treats untrusted non-numeric rating and added values as missing', () => {
    const items = [
      item('nullRating', { rating: null as unknown as string }),
      item('rated', { rating: '1' }),
      item('infinite', { addedAt: Infinity }),
      item('boolean', { addedAt: true as unknown as number }),
      item('added', { addedAt: 5 }),
    ];
    expect(ids(sortCatalogItems(items, 'rating', 'en'))).toEqual([
      'rated', 'nullRating', 'infinite', 'boolean', 'added',
    ]);
    expect(ids(sortCatalogItems(items, 'added', 'en'))).toEqual([
      'added', 'nullRating', 'rated', 'infinite', 'boolean',
    ]);
  });

  it('keeps ties and missing values in server order, even for large lists', () => {
    // Large enough to take V8's quicksort path, which was unstable before Chromium 70.
    const items: Item[] = [];
    for (let i = 0; i < 600; i++) {
      items.push(item(`i${i}`, {
        name: i % 2 ? 'Same' : 'same',
        rating: i % 3 ? String(i % 5) : '',
        year: i % 4 ? 2000 + (i % 2) : undefined,
      }));
    }
    const isServerOrder = (list: Item[]): boolean => list.every((entry, index) =>
      index === 0 || Number(list[index - 1].id.slice(1)) < Number(entry.id.slice(1)));
    for (const direction of ['asc', 'desc'] as const) {
      expect(isServerOrder(sortCatalogItems(items, 'name', 'en', direction))).toBe(true);
      for (const sort of ['rating', 'year'] as const) {
        const sorted = sortCatalogItems(items, sort, 'en', direction);
        const groups = new Map<string, Item[]>();
        for (const entry of sorted) {
          const key = sort === 'rating' ? entry.rating : String(entry.year);
          groups.set(key, [...(groups.get(key) ?? []), entry]);
        }
        for (const group of groups.values()) expect(isServerOrder(group)).toBe(true);
        const missingFrom = sorted.findIndex(entry => (sort === 'rating' ? !entry.rating : entry.year === undefined));
        expect(sorted.slice(missingFrom).every(entry =>
          sort === 'rating' ? !entry.rating : entry.year === undefined)).toBe(true);
      }
    }
  });

  it('handles empty and single-item lists', () => {
    expect(sortCatalogItems([], 'name', 'en')).toEqual([]);
    const one = [item('a', { rating: '1' })];
    const sorted = sortCatalogItems(one, 'rating', 'en', 'asc');
    expect(sorted).toEqual(one);
    expect(sorted).not.toBe(one);
  });
});
