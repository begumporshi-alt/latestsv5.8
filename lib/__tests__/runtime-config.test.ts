/**
 * Runtime connection config resolution (lib/runtime-config.ts).
 *
 * Precedence: window.__SUPABASE_CONFIG__ (server-injected) > localStorage
 * cache > build-time NEXT_PUBLIC_* env. See the module doc for why.
 */
import { getSupabaseConfig } from '../runtime-config';

type Store = Record<string, string>;

function fakeWindow(store: Store, injected?: unknown) {
  const w = {
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    },
  } as unknown as Window & typeof globalThis;
  if (injected !== undefined) (w as unknown as Record<string, unknown>)['__SUPABASE_CONFIG__'] = injected;
  return w;
}

describe('getSupabaseConfig', () => {
  const savedEnv = { ...process.env };
  const savedWindow = global.window;

  afterEach(() => {
    process.env = { ...savedEnv };
    (global as Record<string, unknown>).window = savedWindow;
  });

  test('injected config wins and is written to the cache', () => {
    const store: Store = {};
    (global as Record<string, unknown>).window = fakeWindow(store, {
      url: 'http://127.0.0.1:55431/',
      anonKey: 'injected-key',
    });
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    expect(getSupabaseConfig()).toEqual({ url: 'http://127.0.0.1:55431', anonKey: 'injected-key' });
    expect(JSON.parse(store['sisolution.runtime-config'])).toEqual({
      url: 'http://127.0.0.1:55431',
      anonKey: 'injected-key',
    });
  });

  test('localStorage cache is used when nothing is injected', () => {
    const store: Store = {
      'sisolution.runtime-config': JSON.stringify({ url: 'https://cloud.example.test', anonKey: 'cached-key' }),
    };
    (global as Record<string, unknown>).window = fakeWindow(store);
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    expect(getSupabaseConfig()).toEqual({ url: 'https://cloud.example.test', anonKey: 'cached-key' });
  });

  test('corrupt cache entries are ignored, env fallback still applies', () => {
    const store: Store = { 'sisolution.runtime-config': '{not json' };
    (global as Record<string, unknown>).window = fakeWindow(store);
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://build-time.example.test';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'env-key';

    expect(getSupabaseConfig()).toEqual({ url: 'https://build-time.example.test', anonKey: 'env-key' });
  });

  test('server side (no window) uses the runtime env', () => {
    delete (global as Record<string, unknown>).window;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:55431';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'server-key';

    expect(getSupabaseConfig()).toEqual({ url: 'http://127.0.0.1:55431', anonKey: 'server-key' });
  });

  test('throws when no source has a complete config', () => {
    (global as Record<string, unknown>).window = fakeWindow({});
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    expect(() => getSupabaseConfig()).toThrow(/Supabase connection config is missing/);
  });
});
