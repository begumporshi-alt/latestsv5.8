/**
 * Unit tests for lib/offline/session.resolveUserId.
 *
 * This function names the namespace every local read and write is filed under,
 * and the key they are sealed with, so getting it wrong is a data-correctness
 * problem rather than a cosmetic one. Two properties matter:
 *
 *  1. It must NOT wait on the network when the auth library already has a
 *     session on disk. Awaiting getSession() there put a cold-start token
 *     refresh in front of every cache read — which is what made the first POS
 *     open slow despite the catalogue being cached locally.
 *  2. When there is no stored session it must still resolve the identity the
 *     old way, because there is nothing else to go on.
 *
 * The decisive test is the first one: getSession() is stubbed with a promise
 * that never settles, so any implementation that awaits it hangs forever.
 */

jest.mock('../db', () => {
  const meta = new Map<string, unknown>();
  return {
    __meta: meta,
    getMeta: jest.fn(async (k: string) => meta.get(k)),
    setMeta: jest.fn(async (k: string, v: unknown) => {
      meta.set(k, v);
    }),
  };
});

const getSession = jest.fn();
jest.mock('../../supabase-raw', () => ({
  supabaseRaw: { auth: { getSession: (...args: unknown[]) => getSession(...args) } },
}));

// The storage key is `sb-<project-ref>-auth-token`, so the module needs to know
// which project it is talking to. Set it through the environment rather than
// mocking the config module: both the runtime resolver and the direct env read
// end up here, so this exercises the real path instead of a stand-in.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcd.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-key';

type SessionModule = typeof import('../session');

const REF = 'abcd';
const AUTH_KEY = `sb-${REF}-auth-token`;

let store: Map<string, string>;

function storedSession(id: string, email = 'a@example.com') {
  return JSON.stringify({ access_token: 'x', refresh_token: 'y', user: { id, email } });
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  store = new Map();
  (globalThis as any).window = {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as any).window;
});

/** Fresh module instance, so `memory` does not leak between cases. */
function load(): SessionModule {
  return require('../session') as SessionModule;
}

describe('resolveUserId', () => {
  it('answers from the stored session without waiting for a token refresh', async () => {
    store.set(AUTH_KEY, storedSession('user-from-disk'));
    // Never settles: an implementation that awaits this cannot return.
    getSession.mockReturnValue(new Promise(() => {}));

    const { resolveUserId } = load();
    const id = await resolveUserId();

    expect(id).toBe('user-from-disk');
  });

  it('asks auth-js when nothing is stored, and uses its answer', async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: 'live-user', email: 'l@example.com' } } } });

    const { resolveUserId } = load();
    const id = await resolveUserId();

    expect(id).toBe('live-user');
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('falls back to the remembered user when auth-js has no session', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const db = jest.requireMock('../db') as { __meta: Map<string, unknown> };
    db.__meta.set('session:last-user', { id: 'remembered-user', email: null, at: Date.now() });

    const { resolveUserId } = load();
    const id = await resolveUserId();

    expect(id).toBe('remembered-user');
  });

  it('returns null when there is neither a stored session nor a remembered user', async () => {
    getSession.mockResolvedValue({ data: { session: null } });

    const { resolveUserId } = load();
    await expect(resolveUserId()).resolves.toBeNull();
  });

  it('ignores a corrupt stored session and falls back to auth-js', async () => {
    store.set(AUTH_KEY, 'not-json');
    getSession.mockResolvedValue({ data: { session: { user: { id: 'live-user', email: null } } } });

    const { resolveUserId } = load();
    await expect(resolveUserId()).resolves.toBe('live-user');
  });
});
