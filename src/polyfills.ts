// Runtime polyfills for APIs missing on webOS 4 (Chromium 53):
// - Object.entries / Object.values (Chrome 54): app and EPG object iteration.
// - String.prototype.padStart (Chrome 57): time, URL and settings formatting.
// - Intl.PluralRules (Chrome 63): localized plural selection in src/i18n.
// - scrollIntoView options (Chrome 61): nearest/start element scrolling.
// - ResizeObserver (Chrome 64): bundled assjs subtitle layout.
// - AbortController (Chrome 66): app fetch cancellation and timeouts.
// - Array.prototype.flatMap (Chrome 69): bundled assjs subtitle processing.
// - Object.fromEntries (Chrome 73): bundled assjs subtitle processing.
// - ParentNode.append (Chrome 54): bundled assjs subtitle rendering.
// - Node.getRootNode (Chrome 54): bundled assjs subtitle rendering.
//
// Imported first in both src/app.ts and src/workers/app-worker.ts so they
// apply before any app or dependency code runs. Each install is guarded so
// native behavior is retained wherever the platform supplies the required API.

function scrollAxisOffset(
  itemStart: number,
  itemEnd: number,
  viewportStart: number,
  viewportEnd: number,
  align: ScrollLogicalPosition,
): number {
  if (align === 'start') return itemStart - viewportStart;
  if (align === 'end') return itemEnd - viewportEnd;
  if (align === 'center') {
    return (itemStart + itemEnd - viewportStart - viewportEnd) / 2;
  }
  if (itemStart < viewportStart) return itemStart - viewportStart;
  if (itemEnd > viewportEnd) return itemEnd - viewportEnd;
  return 0;
}

export function scrollIntoViewFallback(
  element: Element,
  options: ScrollIntoViewOptions,
): void {
  for (
    let ancestor = element.parentElement;
    ancestor && ancestor !== document.body;
    ancestor = ancestor.parentElement
  ) {
    const style = getComputedStyle(ancestor);
    const item = element.getBoundingClientRect();
    const viewport = ancestor.getBoundingClientRect();

    if (
      ancestor.scrollHeight > ancestor.clientHeight
      && (style.overflowY === 'auto' || style.overflowY === 'scroll')
    ) {
      ancestor.scrollTop += scrollAxisOffset(
        item.top,
        item.bottom,
        viewport.top,
        viewport.bottom,
        options.block ?? 'start',
      );
    }

    if (
      ancestor.scrollWidth > ancestor.clientWidth
      && (style.overflowX === 'auto' || style.overflowX === 'scroll')
    ) {
      ancestor.scrollLeft += scrollAxisOffset(
        item.left,
        item.right,
        viewport.left,
        viewport.right,
        options.inline ?? 'nearest',
      );
    }
  }
}

function installScrollIntoViewOptions(): void {
  if (
    typeof document === 'undefined'
    || typeof Element === 'undefined'
  ) return;

  // Chromium 38 (webOS 3.9) does not support scrollBehavior in scrollIntoView;
  // it treats scrollIntoView(options) as scrollIntoView(true). CSSOM stores any
  // value assigned to style.scrollBehavior, so reading it back cannot detect
  // support. Use CSS.supports when available; when unavailable (Chromium 38) or
  // when scrollBehavior is not recognized as a CSS property (value is undefined
  // rather than ''), assume options are not supported and install the polyfill.
  let optionsSupported = false;
  if (
    typeof CSS !== 'undefined'
    && typeof CSS.supports === 'function'
  ) {
    optionsSupported = CSS.supports('scroll-behavior', 'smooth');
  }
  if (
    optionsSupported
    && typeof document !== 'undefined'
    && document.documentElement
    && typeof document.documentElement.style.scrollBehavior === 'undefined'
  ) {
    optionsSupported = false;
  }
  if (optionsSupported) return;

  const nativeScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (
    arg?: boolean | ScrollIntoViewOptions,
  ): void {
    if (typeof arg !== 'object' || arg === null) {
      if (typeof nativeScrollIntoView === 'function') {
        nativeScrollIntoView.call(this, arg);
      }
      return;
    }
    scrollIntoViewFallback(this, arg);
  };
}

installScrollIntoViewOptions();

type LegacyAbortListener = EventListenerOrEventListenerObject;

class LegacyAbortSignal {
  aborted = false;
  onabort: ((this: AbortSignal, ev: Event) => unknown) | null = null;
  private listeners: LegacyAbortListener[] = [];

  dispatchAbort(): void {
    if (this.aborted) return;
    this.aborted = true;
    const event = new Event('abort');
    for (const listener of this.listeners.slice()) {
      if (typeof listener === 'function') listener.call(this, event);
      else listener.handleEvent(event);
    }
    this.listeners = [];
    if (this.onabort) this.onabort.call(this as unknown as AbortSignal, event);
  }

  addEventListener(
    type: string,
    callback: LegacyAbortListener | null,
  ): void {
    if (type === 'abort' && callback && this.listeners.indexOf(callback) === -1) {
      this.listeners.push(callback);
    }
  }

  removeEventListener(type: string, callback: LegacyAbortListener | null): void {
    if (type !== 'abort' || !callback) return;
    const index = this.listeners.indexOf(callback);
    if (index !== -1) this.listeners.splice(index, 1);
  }
}

class LegacyAbortController {
  readonly signal = new LegacyAbortSignal();

  abort(): void {
    this.signal.dispatchAbort();
  }
}

function abortError(): Error {
  try {
    return new DOMException('The operation was aborted.', 'AbortError');
  } catch {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
  }
}

function installAbortController(): void {
  if (typeof AbortController !== 'undefined') return;
  const scope = self as unknown as {
    AbortController: typeof AbortController;
    fetch: typeof fetch;
  };
  const nativeFetch = scope.fetch;
  scope.AbortController = LegacyAbortController as unknown as typeof AbortController;
  scope.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    if (!signal) return nativeFetch(input, init);
    if (signal.aborted) return Promise.reject(abortError());
    // Chromium 53's fetch has no `signal` member and ignores it, but forwarding
    // the stand-in signal is still wrong: any engine that does know the member
    // rejects an object that is not a real AbortSignal. Abort is handled here.
    const rest: RequestInit = {};
    for (const key in init) {
      if (key !== 'signal') (rest as Record<string, unknown>)[key] = (init as Record<string, unknown>)[key];
    }
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      nativeFetch(input, rest).then(
        response => {
          signal.removeEventListener('abort', onAbort);
          resolve(response);
        },
        error => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  };
}

installAbortController();

function pluralLanguage(locale?: string | string[]): string {
  const selected = Array.isArray(locale) ? locale[0] : locale;
  return String(selected || 'en').toLowerCase().split(/[-_]/)[0];
}

export function selectPluralCategory(locale: string, value: number): Intl.LDMLPluralRule {
  const count = Math.abs(Number(value) || 0);
  const integer = Math.floor(count);
  const isInteger = count === integer;
  if (!isInteger || locale === 'zh') return 'other';

  if (locale === 'ru' || locale === 'uk') {
    const mod10 = integer % 10;
    const mod100 = integer % 100;
    if (mod10 === 1 && mod100 !== 11) return 'one';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
    return 'many';
  }

  if (locale === 'pl') {
    const mod10 = integer % 10;
    const mod100 = integer % 100;
    if (integer === 1) return 'one';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
    return 'many';
  }

  if ((locale === 'fr' || locale === 'pt') && (integer === 0 || integer === 1)) {
    return 'one';
  }
  return integer === 1 ? 'one' : 'other';
}

// This is intentionally not a complete ECMA-402 implementation. It provides
// cardinal selection for the app's locales and integer UI counts; native
// Intl.PluralRules remains untouched wherever the platform supplies it. When
// adding a locale, add its cardinal rules and coverage in polyfills.test.ts.
class LegacyPluralRules {
  private readonly locale: string;

  constructor(locale?: string | string[]) {
    this.locale = pluralLanguage(locale);
  }

  select(value: number): Intl.LDMLPluralRule {
    return selectPluralCategory(this.locale, value);
  }

  resolvedOptions(): { locale: string; type: 'cardinal' } {
    return { locale: this.locale, type: 'cardinal' };
  }

  static supportedLocalesOf(locales: string | string[]): string[] {
    return Array.isArray(locales) ? locales.slice() : [locales];
  }
}

if (typeof Intl.PluralRules !== 'function') {
  (Intl as unknown as { PluralRules: typeof Intl.PluralRules }).PluralRules =
    LegacyPluralRules as unknown as typeof Intl.PluralRules;
}

class LegacyResizeObserver {
  private readonly elements: Element[] = [];
  private readonly notify = () => {
    this.callback([], this as unknown as ResizeObserver);
  };

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(element: Element): void {
    if (this.elements.indexOf(element) !== -1) return;
    this.elements.push(element);
    window.addEventListener('resize', this.notify);
    element.addEventListener('loadedmetadata', this.notify);
  }

  unobserve(element: Element): void {
    const index = this.elements.indexOf(element);
    if (index === -1) return;
    this.elements.splice(index, 1);
    element.removeEventListener('loadedmetadata', this.notify);
    if (this.elements.length === 0) window.removeEventListener('resize', this.notify);
  }

  disconnect(): void {
    for (const element of this.elements) {
      element.removeEventListener('loadedmetadata', this.notify);
    }
    this.elements.length = 0;
    window.removeEventListener('resize', this.notify);
  }
}

if (typeof ResizeObserver === 'undefined' && typeof window !== 'undefined') {
  (self as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    LegacyResizeObserver as unknown as typeof ResizeObserver;
}
export function flatMapPolyfill(
  this: unknown[],
  callback: (value: unknown, index: number, array: unknown[]) => unknown,
  thisArg?: unknown,
): unknown[] {
  if (this == null) throw new TypeError('flatMap called on null or undefined');
  if (typeof callback !== 'function') throw new TypeError(String(callback) + ' is not a function');
  const arr = Object(this);
  const len = arr.length >>> 0;
  const result: unknown[] = [];
  for (let i = 0; i < len; i++) {
    if (i in arr) {
      const mapped = callback.call(thisArg, arr[i], i, arr);
      if (Array.isArray(mapped)) {
        for (let j = 0; j < mapped.length; j++) {
          if (j in mapped) result.push(mapped[j]);
        }
      } else {
        result.push(mapped);
      }
    }
  }
  return result;
}

if (!(Array.prototype as any).flatMap) {
  (Array.prototype as unknown as { flatMap: typeof flatMapPolyfill }).flatMap = flatMapPolyfill;
}

export function padStartPolyfill(
  this: string,
  targetLength: number,
  padString = ' ',
): string {
  const value = String(this);
  const length = Math.max(0, Math.min(Number(targetLength) || 0, 0x1fffffff));
  if (value.length >= length || padString === '') return value;
  let padding = '';
  while (padding.length < length - value.length) padding += padString;
  return padding.slice(0, length - value.length) + value;
}

if (!(String.prototype as any).padStart) {
  (String.prototype as unknown as { padStart: typeof padStartPolyfill }).padStart =
    padStartPolyfill;
}

export function objectValuesPolyfill(object: object): unknown[] {
  return Object.keys(Object(object)).map(key => (object as Record<string, unknown>)[key]);
}

if (!(Object as any).values) {
  (Object as unknown as { values: typeof objectValuesPolyfill }).values = objectValuesPolyfill;
}

export function objectEntriesPolyfill(object: object): [string, unknown][] {
  return Object.keys(Object(object))
    .map(key => [key, (object as Record<string, unknown>)[key]]);
}

if (!(Object as any).entries) {
  (Object as unknown as { entries: typeof objectEntriesPolyfill }).entries =
    objectEntriesPolyfill;
}

export function fromEntriesPolyfill(
  entries: Iterable<readonly [PropertyKey, unknown]>,
): Record<PropertyKey, unknown> {
  if (entries == null) throw new TypeError('Object.fromEntries called on non-object');
  const obj: Record<PropertyKey, unknown> = {};
  for (const pair of entries) {
    obj[pair[0]] = pair[1];
  }
  return obj;
}

if (!(Object as any).fromEntries) {
  (Object as unknown as { fromEntries: typeof fromEntriesPolyfill }).fromEntries = fromEntriesPolyfill;
}

export function appendPolyfill(this: Node, ...nodes: (Node | string)[]): void {
  for (const node of nodes) {
    this.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
  }
}

if (typeof window !== 'undefined') {
  for (const ctor of [Element, Document, DocumentFragment]) {
    if (ctor && !(ctor.prototype as any).append) {
      (ctor.prototype as unknown as { append: typeof appendPolyfill }).append = appendPolyfill;
    }
  }
}

export function getRootNodePolyfill(this: Node): Node {
  let node: Node = this;
  while (node.parentNode) node = node.parentNode;
  return node;
}

if (typeof window !== 'undefined' && !(Node.prototype as any).getRootNode) {
  (Node.prototype as unknown as { getRootNode: typeof getRootNodePolyfill }).getRootNode =
    getRootNodePolyfill;
}

// Chromium 38 (webOS 3.9): HTMLVideoElement.play() returns undefined instead of
// a Promise (Promise-returning play() was added in Chrome 42). Patch it so
// callers can safely chain .catch() on the result.
if (
  typeof HTMLVideoElement !== 'undefined'
  && typeof HTMLVideoElement.prototype.play === 'function'
) {
  const nativePlay = HTMLVideoElement.prototype.play;
  HTMLVideoElement.prototype.play = function (this: HTMLVideoElement): Promise<void> {
    return Promise.resolve(nativePlay.call(this));
  };
}

// Chromium 38 (webOS 3.9) lacks Object.assign (Chrome 45+) and fetch (Chrome 42+).
// These polyfills are feature-detected so they are no-ops on newer engines.
if (typeof Object.assign !== 'function') {
  Object.assign = function (target: any, ...sources: any[]): any {
    if (target == null) throw new TypeError('Cannot convert undefined or null to object');
    const to = Object(target);
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (source != null) {
        for (const key in source) {
          if (Object.prototype.hasOwnProperty.call(source, key)) to[key] = source[key];
        }
      }
    }
    return to;
  } as any;
}

function installFetchPolyfill(): void {
  if (typeof self === 'undefined') return;
  if (typeof fetch !== 'undefined') return;
  if (typeof XMLHttpRequest === 'undefined' || typeof Promise === 'undefined') return;

  const toHeaderMap = (init: any): Record<string, string> => {
    const map: Record<string, string> = {};
    if (!init) return map;
    if (Array.isArray(init)) {
      for (let i = 0; i < init.length; i++) {
        const pair = init[i];
        map[String(pair[0]).toLowerCase()] = String(pair[1]);
      }
    } else {
      for (const key of Object.keys(init)) map[key.toLowerCase()] = String(init[key]);
    }
    return map;
  };

  class ResponsePolyfill {
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly url: string;
    readonly headers: Record<string, string> & { get(name: string): string | null };
    readonly body: null = null;
    private _text = '';
    _buf: ArrayBuffer | null = null;

    constructor(body: string | ArrayBuffer | null, init: any = {}) {
      this.status = init.status === undefined ? 200 : Number(init.status);
      this.ok = this.status >= 200 && this.status < 300;
      this.statusText = init.statusText === undefined ? '' : String(init.statusText);
      this.url = init.url || '';
      const headersMap = toHeaderMap(init.headers);
      this.headers = headersMap as Record<string, string> & { get(name: string): string | null };
      this.headers.get = (name: string) => headersMap[String(name).toLowerCase()] ?? null;
      if (typeof body === 'string') this._text = body;
      else if (body instanceof ArrayBuffer) this._buf = body;
    }

    text(): Promise<string> {
      return Promise.resolve(this._text);
    }

    json(): Promise<any> {
      return this.text().then(t => JSON.parse(t));
    }

    arrayBuffer(): Promise<ArrayBuffer> {
      if (this._buf) return Promise.resolve(this._buf);
      const bytes = new Uint8Array(this._text.length);
      for (let i = 0; i < this._text.length; i++) bytes[i] = this._text.charCodeAt(i) & 0xff;
      return Promise.resolve(bytes.buffer);
    }
  }

  (self as any).fetch = function (input: any, init: any = {}): Promise<ResponsePolyfill> {
    const xhr = new XMLHttpRequest();
    const method = (init.method || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : String(input);
    xhr.open(method, url, true);

    for (const [k, v] of Object.entries(toHeaderMap(init.headers))) {
      xhr.setRequestHeader(k, v);
    }

    const signal = init.signal;
    if (signal) {
      const onAbort = () => xhr.abort();
      signal.addEventListener('abort', onAbort);
      xhr.addEventListener('loadend', () => signal.removeEventListener('abort', onAbort));
      if (signal.aborted) {
        xhr.abort();
        return Promise.reject(new Error('Aborted'));
      }
    }

    return new Promise<ResponsePolyfill>((resolve, reject) => {
      xhr.onload = () => {
        const raw = xhr.getAllResponseHeaders();
        const headers: Record<string, string> = {};
        for (const line of raw.split('\r\n')) {
          const idx = line.indexOf(':');
          if (idx > 0) {
            headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
          }
        }
        const rt = xhr.responseType;
        const text = rt === '' || rt === 'text' ? xhr.responseText : '';
        const buf = rt === 'arraybuffer' ? xhr.response : null;
        const res = new ResponsePolyfill(buf ? null : text, {
          status: xhr.status,
          statusText: xhr.statusText,
          url: xhr.responseURL || url,
          headers,
        });
        if (buf) res._buf = buf;
        resolve(res);
      };
      xhr.onabort = () => { if (!aborted) reject(new Error('Aborted')); };
      xhr.onerror = () => reject(new TypeError('Failed to fetch'));
      xhr.ontimeout = () => reject(new TypeError('Failed to fetch'));
      let aborted = false;
      xhr.send(init.body === undefined ? null : init.body);
    });
  } as any;
}

if (typeof self !== 'undefined') installFetchPolyfill();

// Map polyfill (Chrome 38 lacks Map - Chrome 43+)
if (typeof Map === 'undefined') {
  // Minimal Map polyfill for ES5
  (self as any).Map = class MapPolyfill<K, V> {
    private _keys: K[] = [];
    private _values: V[] = [];
    constructor(iterable?: Iterable<[K, V]>) {
      if (iterable) {
        for (const [k, v] of iterable) this.set(k, v);
      }
    }
    get size(): number { return this._keys.length; }
    has(key: K): boolean { return this._keys.indexOf(key) !== -1; }
    get(key: K): V | undefined {
      const i = this._keys.indexOf(key);
      return i !== -1 ? this._values[i] : undefined;
    }
    set(key: K, value: V): this {
      const i = this._keys.indexOf(key);
      if (i !== -1) this._values[i] = value;
      else { this._keys.push(key); this._values.push(value); }
      return this;
    }
    delete(key: K): boolean {
      const i = this._keys.indexOf(key);
      if (i !== -1) { this._keys.splice(i, 1); this._values.splice(i, 1); return true; }
      return false;
    }
    clear(): void { this._keys = []; this._values = []; }
    forEach(callback: (value: V, key: K, map: any) => void, thisArg?: any): void {
      for (let i = 0; i < this._keys.length; i++) callback.call(thisArg, this._values[i], this._keys[i], this);
    }
    *[Symbol.iterator](): Iterator<[K, V]> {
      for (let i = 0; i < this._keys.length; i++) yield [this._keys[i], this._values[i]];
    }
    entries() { return this[Symbol.iterator](); }
    keys() { return this._keys.values(); }
    values() { return this._values.values(); }
  };
}

// Set polyfill (Chrome 38 lacks Set - Chrome 43+)
if (typeof Set === 'undefined') {
  (self as any).Set = class SetPolyfill<T> {
    private _values: T[] = [];
    constructor(iterable?: Iterable<T>) {
      if (iterable) for (const v of iterable) this.add(v);
    }
    get size(): number { return this._values.length; }
    has(value: T): boolean { return this._values.indexOf(value) !== -1; }
    add(value: T): this { if (!this.has(value)) this._values.push(value); return this; }
    delete(value: T): boolean { const i = this._values.indexOf(value); if (i !== -1) { this._values.splice(i, 1); return true; } return false; }
    clear(): void { this._values = []; }
    forEach(callback: (value: T, value2: T, set: any) => void, thisArg?: any): void {
      for (let i = 0; i < this._values.length; i++) callback.call(thisArg, this._values[i], this._values[i], this);
    }
    *[Symbol.iterator](): Iterator<T> { for (const v of this._values) yield v; }
    keys() { return this._values.values(); }
    values() { return this._values.values(); }
    entries() { return this[Symbol.iterator](); }
  };
}

// WeakMap polyfill (Chrome 38 lacks WeakMap - Chrome 42+)
// Uses a hidden property on the key object (approximation, not true weak references)
if (typeof WeakMap === 'undefined') {
  (self as any).WeakMap = class WeakMapPolyfill<K extends object, V> {
    private data: any;
    constructor(iterable?: Iterable<[K, V]>) {
      this.data = new (self as any).Map();
      if (iterable) for (const [k, v] of iterable) this.set(k, v);
    }
    has(key: K): boolean { return this.data.has(key); }
    get(key: K): V | undefined { return this.data.get(key); }
    set(key: K, value: V): this { this.data.set(key, value); return this; }
    delete(key: K): boolean { return this.data.delete(key); }
  };
}

// WeakSet polyfill (Chrome 38 lacks WeakSet - Chrome 42+)
if (typeof WeakSet === 'undefined') {
  (self as any).WeakSet = class WeakSetPolyfill<T extends object> {
    private data: any;
    constructor(iterable?: Iterable<T>) {
      this.data = new (self as any).Map();
      if (iterable) for (const v of iterable) this.add(v);
    }
    has(value: T): boolean { return this.data.has(value); }
    add(value: T): this { this.data.set(value, true); return this; }
    delete(value: T): boolean { return this.data.delete(value); }
  };
}

// Array.prototype.includes (Chrome 47+)
if (!Array.prototype.includes) {
  Array.prototype.includes = function (searchElement: any, fromIndex?: number): boolean {
    const o = Object(this);
    const len = o.length >>> 0;
    if (len === 0) return false;
    const n = (fromIndex !== undefined ? fromIndex : 0) | 0;
    let k = Math.max(n >= 0 ? n : len - Math.abs(n), 0);
    for (; k < len; k++) {
      if (k in o && o[k] === searchElement) return true;
    }
    return false;
  };
}

// String.prototype.includes (Chrome 47+)
if (!String.prototype.includes) {
  String.prototype.includes = function (searchString: string, position?: number): boolean {
    return this.indexOf(searchString, position) !== -1;
  };
}

// String.prototype.startsWith (Chrome 41+)
if (!String.prototype.startsWith) {
  String.prototype.startsWith = function (searchString: string, position?: number): boolean {
    const str = String(this);
    const pos = position == null ? 0 : Math.max(0, Math.min(position | 0, str.length));
    return str.indexOf(searchString, pos) === pos;
  };
}

// String.prototype.endsWith (Chrome 41+)
if (!String.prototype.endsWith) {
  String.prototype.endsWith = function (searchString: string, length?: number): boolean {
    const str = String(this);
    const end = length == null || length > str.length ? str.length : length | 0;
    const searchStr = String(searchString);
    return str.slice(end - searchStr.length, end) === searchStr;
  };
}

// Array.prototype.find (Chrome 45+)
if (!Array.prototype.find) {
  Array.prototype.find = function <T>(callback: (value: T, index: number, array: T[]) => boolean, thisArg?: any): T | undefined {
    const o = Object(this);
    const len = o.length >>> 0;
    if (typeof callback !== 'function') throw new TypeError(callback + ' is not a function');
    for (let i = 0; i < len; i++) {
      if (i in o) {
        const val = o[i];
        if (callback.call(thisArg, val, i, o)) return val;
      }
    }
    return undefined;
  };
}

// Array.prototype.findIndex (Chrome 45+)
if (!Array.prototype.findIndex) {
  Array.prototype.findIndex = function <T>(callback: (value: T, index: number, array: T[]) => boolean, thisArg?: any): number {
    const o = Object(this);
    const len = o.length >>> 0;
    if (typeof callback !== 'function') throw new TypeError(callback + ' is not a function');
    for (let i = 0; i < len; i++) {
      if (i in o) {
        const val = o[i];
        if (callback.call(thisArg, val, i, o)) return i;
      }
    }
    return -1;
  };
}

// Array.from (Chrome 45+)
if (!Array.from) {
  Array.from = function (arrayLike: any, mapFn?: (v: any, k: number) => any, thisArg?: any): any[] {
    const result: any[] = [];
    if (arrayLike && typeof arrayLike[Symbol.iterator] === 'function') {
      for (const item of arrayLike) result.push(item);
    } else if (arrayLike && typeof arrayLike.length === 'number') {
      const len = arrayLike.length >>> 0;
      for (let i = 0; i < len; i++) result.push(arrayLike[i]);
    }
    if (mapFn) {
      for (let i = 0; i < result.length; i++) result[i] = mapFn.call(thisArg, result[i], i);
    }
    return result;
  };
}

// Element.closest() (Chrome 41+)
if (typeof Element !== 'undefined' && !Element.prototype.closest) {
  Element.prototype.closest = function (selector: string): Element | null {
    let el: Element | null = this;
    while (el) {
      if (el.matches?.(selector)) return el;
      el = el.parentElement;
    }
    return null;
  };
}

// Element.matches() (Chrome 33+ as webkitMatchesSelector, standard in 34+)
if (typeof Element !== 'undefined' && !Element.prototype.matches) {
  const proto = Element.prototype as any;
  proto.matches =
    proto.webkitMatchesSelector ||
    proto.mozMatchesSelector ||
    proto.msMatchesSelector ||
    function (this: Element, selector: string): boolean {
      const doc = this.ownerDocument;
      const matches = doc.querySelectorAll(selector);
      for (let i = 0; i < matches.length; i++) {
        if (matches[i] === this) return true;
      }
      return false;
    };
}

// NodeList.prototype.forEach (Chrome 51+)
if (typeof NodeList !== 'undefined' && !NodeList.prototype.forEach) {
  NodeList.prototype.forEach = function (callback: any, thisArg?: any): void {
    for (let i = 0; i < this.length; i++) {
      callback.call(thisArg, this[i], i, this);
    }
  };
}
