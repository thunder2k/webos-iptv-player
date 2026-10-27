import { createLogger } from '../utils/logger';

const log = createLogger('PersistenceDB');

export const EPG_STORE = 'epg-cache';
export const CATALOG_STORE = 'catalog-cache';
export const SUBTITLE_STORE = 'subtitle-cache';
export const PLAYLIST_STORE = 'playlist-cache';
export const STREAM_MIME_STORE = 'stream-mime-cache';
export const CHANNEL_HEALTH_STORE = 'channel-health-cache';
export const CACHE_META_STORE = 'cache-meta';
export const CACHE_STORES = [
  EPG_STORE,
  CATALOG_STORE,
  SUBTITLE_STORE,
  PLAYLIST_STORE,
  STREAM_MIME_STORE,
  CHANNEL_HEALTH_STORE,
] as const;
export type CacheStore = typeof CACHE_STORES[number];

export const USER_DATA_STORES = [
  'favorites',
  'reminders',
  'channel-state',
  'watchlist',
  'playback-progress',
  'recently-watched',
  'online-sub-picks',
  'parental-control',
] as const;
export type UserDataStore = typeof USER_DATA_STORES[number];
export const USER_META_STORE = 'user-meta';

let dbPromise: Promise<IDBDatabase | null> | null = null;

export function cacheKeyPath(store: CacheStore): 'url' | 'key' {
  return store === EPG_STORE ? 'url' : 'key';
}

export function openPersistenceDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  // Force localStorage-only mode on webOS 3.9 (Chromium 38) where IndexedDB is unreliable
  log.warn(
    'Forcing localStorage-only mode (IndexedDB disabled)',
    'event=persistence.db.forced_localstorage',
    'operation=open',
  );
  return Promise.resolve(null);
}

export function transactionDone(
  tx: IDBTransaction,
  onAbort?: (error: DOMException | null) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => {
      onAbort?.(tx.error);
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

export function requestResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}
