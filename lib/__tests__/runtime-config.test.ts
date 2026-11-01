/**
 * Runtime connection config resolution (lib/runtime-config.ts).
 *
 * Precedence: window.__SUPABASE_CONFIG__ (server-injected) > localStorage
 * cache > build-time NEXT_PUBLIC_* env. See the module doc for why.
 *
 * The cache key is scoped to the Supabase project the build was compiled
 * against, so a device booting from stale cached HTML cannot keep reading a
 * config that points at the previous project after a cutover. That scoping is
 * why this file imports RUNTIME_CONFIG_CACHE_KEY instead of spelling the key
 * out: a literal here rots silently the moment the scope changes.
 */
import { getSupabaseConfig, RUNTIME_CONFIG_CACHE_KEY } from '../runtime-config';

/** The pre-scoping key, which the module now treats as legacy and removes. */
const LEGACY_CACHE_KEY = 'sisolution.runtime-config';

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
    // Seed the legacy key to prove the injected path also clears it.
    const store: Store = { [LEGACY_CACHE_KEY]: '{"url":"https://old.example.test","anonKey":"old"}' };
    (global as Record<string, unknown>).window = fakeWindow(store, {
      url: 'http://127.0.0.1:55431/',
      anonKey: 'injected-key',
    });
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    expect(getSupabaseConfig()).toEqual({ url: 'http://127.0.0.1:55431', anonKey: 'injected-key' });
    expect(JSON.parse(store[RUNTIME_CONFIG_CACHE_KEY])).toEqual({
      url: 'http://127.0.0.1:55431',
      anonKey: 'injected-key',
    });
    // Cutover safety: the pre-scoping entry must not survive this write.
    expect(store[LEGACY_CACHE_KEY]).toBeUndefined();
  });

  test('localStorage cache is used when nothing is injected', () => {
    const store: Store = {
      [RUNTIME_CONFIG_CACHE_KEY]: JSON.stringify({ url: 'https://cloud.example.test', anonKey: 'cached-key' }),
    };
    (global as Record<string, unknown>).window = fakeWindow(store);
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    expect(getSupabaseConfig()).toEqual({ url: 'https://cloud.example.test', anonKey: 'cached-key' });
  });

  test('reading the cache path also clears the legacy key', () => {
    const store: Store = {
      [RUNTIME_CONFIG_CACHE_KEY]: JSON.stringify({ url: 'https://cloud.example.test', anonKey: 'cached-key' }),
      [LEGACY_CACHE_KEY]: JSON.stringify({ url: 'https://old.example.test', anonKey: 'old' }),
    };
    (global as Record<string, unknown>).window = fakeWindow(store);
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    expect(getSupabaseConfig().url).toBe('https://cloud.example.test');
    expect(store[LEGACY_CACHE_KEY]).toBeUndefined();
  });

  test('a config cached under the legacy key is not trusted', () => {
    // Only the legacy key holds a config. It must NOT be used — the whole
    // point of scoping is that the old entry is unreachable.
    const store: Store = {
      [LEGACY_CACHE_KEY]: JSON.stringify({ url: 'https://old.example.test', anonKey: 'old' }),
    };
    (global as Record<string, unknown>).window = fakeWindow(store);
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    expect(() => getSupabaseConfig()).toThrow(/Supabase connection config is missing/);
  });

  test('corrupt cache entries are ignored, env fallback still applies', () => {
    const store: Store = { [RUNTIME_CONFIG_CACHE_KEY]: '{not json' };
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
