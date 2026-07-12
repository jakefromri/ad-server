import { defineConfig, loadEnv } from 'vite';

// Vitest doesn't auto-load .env (CLAUDE.md's Integration Test Setup
// convention) — loadEnv from vite + `env` below makes .env's real
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/DEVICE_KEY_HASH_SECRET visible to
// process.env inside test files and the server/ modules they import
// (server/supabase.ts, server/hash.ts read process.env directly).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    test: {
      environment: 'node',
      env,
      // Every fixture (createTenantFixture, createSuperadminSession, ...)
      // creates a real Supabase Auth user + signs in via
      // supabaseAuth.auth.signInWithPassword — the dev Supabase project's
      // GoTrue rate limit on sign-ins is per-IP, not per-file, so running
      // many test files' worker processes concurrently (the vitest
      // default) blows through it well before any individual file would.
      // Sequential file execution keeps auth call volume within the limit;
      // see createHumanSession's retry-with-backoff in test/helpers.ts for
      // the remaining defense against occasional bursts even so.
      fileParallelism: false,
      testTimeout: 30000,
      hookTimeout: 30000,
      include: ['test/**/*.test.ts'],
    },
  };
});
