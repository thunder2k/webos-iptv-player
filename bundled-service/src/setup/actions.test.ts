import { describe, expect, it } from 'vitest';
import { parseSetupAction } from './actions';

describe('parseSetupAction', () => {
  it('parses xtream action without label', () => {
    const action = parseSetupAction({
      type: 'xtream',
      serverUrl: 'http://host/l',
      username: 'u1',
      password: 'p1',
    });
    expect(action).toEqual({
      type: 'xtream',
      serverUrl: 'http://host/l',
      username: 'u1',
      password: 'p1',
    });
    expect(action).not.toHaveProperty('label');
  });

  it('parses xtream action with label', () => {
    const action = parseSetupAction({
      type: 'xtream',
      serverUrl: 'http://host/l',
      username: 'u1',
      password: 'p1',
      label: 'My Account',
    });
    expect(action).toEqual({
      type: 'xtream',
      serverUrl: 'http://host/l',
      username: 'u1',
      password: 'p1',
      label: 'My Account',
    });
  });

  it('rejects xtream action with label exceeding max length', () => {
    expect(() =>
      parseSetupAction({
        type: 'xtream',
        serverUrl: 'http://host/l',
        username: 'u1',
        password: 'p1',
        label: 'x'.repeat(121),
      }),
    ).toThrow('Invalid account label');
  });
});
