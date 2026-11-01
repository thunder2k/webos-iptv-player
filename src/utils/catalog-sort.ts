export const CATALOG_SORT_OPTIONS = ['default', 'name', 'added', 'rating', 'year'] as const;
export type CatalogSort = typeof CATALOG_SORT_OPTIONS[number];
export type CatalogSortDirection = 'asc' | 'desc';

export interface CatalogSortPreference {
  by: CatalogSort;
  direction: CatalogSortDirection;
}

export function defaultSortDirection(by: CatalogSort): CatalogSortDirection {
  return by === 'name' || by === 'default' ? 'asc' : 'desc';
}

export interface CatalogSortItem {
  name: string;
  rating: string;
  addedAt?: number;
  year?: number;
}

export function isCatalogSort(value: unknown): value is CatalogSort {
  return typeof value === 'string'
    && CATALOG_SORT_OPTIONS.some(option => option === value);
}

export function isCatalogSortDirection(value: unknown): value is CatalogSortDirection {
  return value === 'asc' || value === 'desc';
}

function numericValue(item: CatalogSortItem, sort: CatalogSort): number | null {
  const raw: unknown = sort === 'added' ? item.addedAt : sort === 'year' ? item.year : item.rating;
  if (typeof raw === 'string' ? !raw.trim() : typeof raw !== 'number') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    && (sort === 'rating' || value > 0) ? value : null;
}

// Returns a new array; items without a usable value trail in both directions.
export function sortCatalogItems<I extends CatalogSortItem>(
  items: readonly I[],
  sort: CatalogSort,
  locale: string,
  direction: CatalogSortDirection = defaultSortDirection(sort),
): I[] {
  if (sort === 'default') return items.slice();
  const collator = sort === 'name'
    ? new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }) : null;
  const sign = direction === 'asc' ? 1 : -1;
  // V8 before Chromium 70 does not guarantee stable Array.sort.
  return items.map((item, index) => ({
    item,
    index,
    name: collator ? item.name.trim() : '',
    value: collator ? null : numericValue(item, sort),
  })).sort((a, b) => {
    if (collator) {
      if (!a.name || !b.name) return (a.name ? -1 : b.name ? 1 : 0) || a.index - b.index;
      return collator.compare(a.name, b.name) * sign || a.index - b.index;
    }
    if (a.value === null || b.value === null) {
      return (a.value !== null ? -1 : b.value !== null ? 1 : 0) || a.index - b.index;
    }
    return (a.value - b.value) * sign || a.index - b.index;
  }).map(entry => entry.item);
}
