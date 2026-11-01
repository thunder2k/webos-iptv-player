import { describe, expect, it } from 'vitest';
import { scanBundle } from './compat-gate.mjs';

describe('compat gate module workers', () => {
  it('rejects module Worker and SharedWorker constructors', () => {
    const violations = scanBundle(`
      new Worker('/worker.js', { type: 'module' });
      new window.SharedWorker('/shared.js', { "type": "module" });
    `);

    expect(violations).toEqual([
      expect.objectContaining({
        name: 'module worker',
        kind: 'worker-option',
        minChrome: 80,
        count: 2,
      }),
    ]);
  });

  it('allows classic workers and unrelated module options', () => {
    expect(scanBundle(`
      new Worker('/worker.js');
      new Worker('/worker.js', { name: 'worker' });
      configure({ type: 'module' });
      const example = "new Worker('/worker.js', { type: 'module' })";
    `)).toEqual([]);
  });
});

describe('compat gate unsupported options', () => {
  it('rejects option-object properties Chromium 53 ignores or misreads', () => {
    const violations = scanBundle(`
      worker.postMessage(bytes, { transfer: [bytes.buffer] });
      target.addEventListener('transitionend', done, { once: true });
      target.addEventListener('click', handler, { signal: controller.signal });
      option.focus({ preventScroll: true });
    `, { allowlist: [] });

    expect(violations).toEqual([
      expect.objectContaining({
        name: 'postMessage transfer options',
        kind: 'call-option',
        count: 1,
      }),
      expect.objectContaining({ name: 'once event listener', kind: 'call-option', minChrome: 55, count: 1 }),
      expect.objectContaining({
        name: 'abortable event listener',
        kind: 'call-option',
        count: 1,
      }),
      expect.objectContaining({ name: 'focus preventScroll', kind: 'call-option', minChrome: 64, count: 1 }),
    ]);
  });

  it('allows legacy transfers and supported option shapes', () => {
    expect(scanBundle(`
      worker.postMessage(bytes, [bytes.buffer]);
      target.addEventListener('click', handler, { capture: true, passive: true });
      target.addEventListener('click', handler, true);
      option.focus();
      configure({ once: true, preventScroll: true });
    `)).toEqual([]);
  });

  it('tolerates the guarded preventScroll call through the allowlist', () => {
    expect(scanBundle('option.focus({ preventScroll: true });')).toEqual([]);
  });

  it('catches shorthand option properties', () => {
    expect(scanBundle(`
      const once = true;
      target.addEventListener('transitionend', done, { once });
    `)).toEqual([
      expect.objectContaining({ name: 'once event listener', count: 1 }),
    ]);
  });

  it('exempts only as many guarded calls as the allowlist maxCount', () => {
    expect(scanBundle(`
      option.focus({ preventScroll: true });
      other.focus({ preventScroll: true });
    `)).toEqual([
      expect.objectContaining({ name: 'focus preventScroll', count: 2 }),
    ]);
  });
});

describe('compat gate unsupported constructors', () => {
  it('rejects post-Chrome-68 constructors', () => {
    const violations = scanBundle(`
      new OffscreenCanvas(10, 10);
      new self.CompressionStream('gzip');
      new globalThis["WeakRef"](value);
    `);

    expect(violations).toEqual([
      expect.objectContaining({ name: 'OffscreenCanvas', kind: 'constructor', count: 1 }),
      expect.objectContaining({ name: 'CompressionStream', kind: 'constructor', count: 1 }),
      expect.objectContaining({ name: 'WeakRef', kind: 'constructor', count: 1 }),
    ]);
  });

  it('allows supported or polyfilled constructors', () => {
    expect(scanBundle(`
      new Worker('/worker.js');
      new TextDecoder('utf-8');
      new AbortController();
      new Intl.PluralRules('en');
    `)).toEqual([]);
  });

  it('detects nested built-in constructors before applying the polyfill allowlist', () => {
    expect(scanBundle(
      `new Intl.PluralRules('en');`,
      { allowlist: [] },
    )).toEqual([
      expect.objectContaining({
        name: 'PluralRules',
        kind: 'constructor',
        minChrome: 63,
        count: 1,
      }),
    ]);
  });
});

describe('compat gate unsupported instance methods', () => {
  it('rejects any receiver calling a denylisted method name, e.g. .finally()', () => {
    const violations = scanBundle(`
      check.finally(cleanup);
      Promise.resolve().finally(() => {});
    `);

    expect(violations).toEqual([
      expect.objectContaining({ name: 'finally', kind: 'method', minChrome: 63, count: 2 }),
    ]);
  });

  it('allows guarded/polyfilled method names, e.g. padStart', () => {
    expect(scanBundle(`
      value.padStart(3, '0');
    `)).toEqual([]);
  });
});
