// Unit tests import modules that construct a Supabase client at module load
// (lib/supabase-raw.ts via lib/offline/session.ts). The client is never used
// for network I/O in unit tests; the URL only has to be well-formed. Values
// already present in the environment are left untouched.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:55431';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
