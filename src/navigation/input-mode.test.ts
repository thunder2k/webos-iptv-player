// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputMode, setInputMode } from './input-mode';

afterEach(() => setInputMode('pointer'));

describe('InputMode', () => {
  it('reads and writes the keyboard-nav class that CSS styles from', () => {
    expect(InputMode.current).toBe('pointer');
    setInputMode('keys');
    expect(document.documentElement.classList.contains('keyboard-nav')).toBe(true);
    expect(InputMode.current).toBe('keys');
    setInputMode('pointer');
    expect(document.documentElement.classList.contains('keyboard-nav')).toBe(false);
  });

  it('tells subscribers only about real switches until they unsubscribe', () => {
    const fn = vi.fn();
    const off = InputMode.onChange(fn);
    setInputMode('keys');
    setInputMode('keys');
    setInputMode('pointer');
    off();
    setInputMode('keys');
    expect(fn.mock.calls).toEqual([['keys'], ['pointer']]);
  });
});
