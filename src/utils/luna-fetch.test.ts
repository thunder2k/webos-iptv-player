// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchViaLuna } from './luna-fetch';

const mocks = vi.hoisted(() => ({
  lunaRequest: vi.fn(),
  isLunaAvailable: vi.fn(() => true),
}));

vi.mock('../services/luna', () => ({
  isLunaAvailable: mocks.isLunaAvailable,
  lunaRequest: mocks.lunaRequest,
}));

interface LunaCall {
  uri: string;
  options: {
    method: string;
    parameters: { url: string; method?: string; body?: string };
    onSuccess: (resp: unknown) => void;
    onFailure: (err: unknown) => void;
  };
}

const calls: LunaCall[] = [];

function installMockLuna(): void {
  mocks.lunaRequest.mockImplementation(
    (
      uri: string,
      options: {
        method: string;
        parameters: { url: string; method?: string; body?: string };
        onSuccess: (resp: unknown) => void;
        onFailure: (err: unknown) => void;
      }
    ) => {
      calls.push({ uri, options });
      return { cancel: vi.fn() };
    }
  );
}

function lastSuccess(): (resp: unknown) => void {
  return calls[calls.length - 1].options.onSuccess;
}

function lastFailure(): (err: unknown) => void {
  return calls[calls.length - 1].options.onFailure;
}

beforeEach(() => {
  calls.length = 0;
  mocks.lunaRequest.mockClear();
  mocks.isLunaAvailable.mockReturnValue(true);
  installMockLuna();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchViaLuna', () => {
  it('passes GET with no body by default', async () => {
    const promise = fetchViaLuna('http://127.0.0.1:37546/info');
    expect(calls).toHaveLength(1);
    expect(calls[0].uri).toBe('luna://com.lennylxx.iptv.service');
    expect(calls[0].options.method).toBe('fetch_url');
    expect(calls[0].options.parameters).toEqual({
      url: 'http://127.0.0.1:37546/info',
      method: 'GET',
      body: undefined,
    });
    lastSuccess()({ ok: true, status: 200, statusText: 'OK', body: '{}' });
    await expect(promise).resolves.toMatchObject({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
  });

  it('passes PUT method and body through to lunaRequest', async () => {
    const state = JSON.stringify({ playlists: [], xtreamAccounts: [] });
    const promise = fetchViaLuna('http://127.0.0.1:37546/setup-state', {
      method: 'PUT',
      body: state,
    });
    expect(calls[0].options.parameters).toEqual({
      url: 'http://127.0.0.1:37546/setup-state',
      method: 'PUT',
      body: state,
    });
    lastSuccess()({ ok: true, status: 200, statusText: 'OK', body: '{ "updated": true }' });
    await expect(promise).resolves.toMatchObject({ ok: true, status: 200 });
  });

  it('passes DELETE method through to lunaRequest', async () => {
    const promise = fetchViaLuna('http://127.0.0.1:37546/setup-actions/3', {
      method: 'DELETE',
    });
    expect(calls[0].options.parameters).toEqual({
      url: 'http://127.0.0.1:37546/setup-actions/3',
      method: 'DELETE',
      body: undefined,
    });
    lastSuccess()({ ok: true, status: 200, statusText: 'OK', body: '{ "deleted": true, "id": 3 }' });
    await expect(promise).resolves.toMatchObject({ ok: true, status: 200 });
  });

  it('rejects when lunaRequest onFailure fires', async () => {
    const promise = fetchViaLuna('http://127.0.0.1:37546/info');
    lastFailure()(new Error('service down'));
    await expect(promise).rejects.toThrow('service down');
  });

  it('throws when Luna is unavailable', async () => {
    mocks.isLunaAvailable.mockReturnValue(false);
    await expect(fetchViaLuna('http://127.0.0.1:37546/info')).rejects.toThrow(
      'Luna not available'
    );
  });
});
