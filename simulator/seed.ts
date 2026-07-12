// Idempotently ensures Tenant 0 (scope.md's "Jake's own internal test
// network, used to drive the virtual screen simulator during development")
// exists, plus a baseline set of seed campaigns for the two convergence
// scenarios PROJECT_PLAN.md's 04e Done-criterion calls for: an
// impression-count campaign, and a competing pair of SOV campaigns.
//
// Tenant 0 is created through the *real* superadmin -> invite-accept flow
// (POST /api/admin/tenants, then POST /api/invites/accept), never a direct
// service-role insert — SESSION_HANDOFF.md flagged this explicitly so 04e
// also proves a working tenant_admin login, not just a row in the DB. A
// service-role read is used only to check whether Tenant 0 already exists
// (an idempotency guard, not a substitute for the real creation flow).
//
// Usage:
//   npx tsx simulator/seed.ts --target-url http://localhost:3010
//
// Writes simulator/.output/tenant0-credentials.json (gitignored — contains a
// live tenant API key and a real user password). Re-running after the first
// successful seed is a no-op that just reuses that file.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { supabaseAdmin } from '../server/supabase';
import type { Campaign } from '../types';

const TENANT_NAME = 'Tenant 0';
const TENANT_ADMIN_EMAIL = 'tenant0-admin@adserver.local';
const OUTPUT_PATH = 'simulator/.output/tenant0-credentials.json';
// Short on purpose (architecture.md default is 300s) so a moderate-length
// functional run can actually exercise the expiry/release path, per
// SESSION_HANDOFF.md's note that the simulator's wait step should stay
// "comfortably under" the timeout for most requests, with a deliberate
// fraction crossing it.
const RESERVATION_TIMEOUT_SECONDS = 20;
// High — Tenant 0 is a long-lived fixture reused across many future
// simulator/load-test runs, not a single-run throwaway.
const FULFILLMENT_QUOTA = 1_000_000;

interface Credentials {
  tenant_id: string;
  tenant_api_key: string;
  tenant_admin_email: string;
  tenant_admin_password: string;
}

function randomPassword(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `Sim-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--target-url');
  const targetUrl = idx >= 0 ? argv[idx + 1] : process.env.K6_TARGET_URL;
  if (!targetUrl) throw new Error('--target-url (or K6_TARGET_URL) is required');
  return { targetUrl };
}

async function signInAsSuperadmin(): Promise<string> {
  const email = process.env.SUPERADMIN_EMAIL;
  if (!email) throw new Error('SUPERADMIN_EMAIL is not set in .env');

  // Password isn't stored anywhere between sessions (04b/04c/04d convention)
  // — reset it to a fresh, script-local-only value each time this needs to
  // sign in, same as prior phases' verification scripts.
  const { data: usersPage, error: listError } = await supabaseAdmin.auth.admin.listUsers();
  if (listError) throw listError;
  const superadmin = usersPage.users.find((u) => u.email === email);
  if (!superadmin) throw new Error(`No Supabase Auth user found for SUPERADMIN_EMAIL=${email}`);

  const tempPassword = randomPassword();
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(superadmin.id, { password: tempPassword });
  if (updateError) throw updateError;

  const { data: signIn, error: signInError } = await supabaseAdmin.auth.signInWithPassword({ email, password: tempPassword });
  if (signInError || !signIn.session) throw signInError ?? new Error('Superadmin sign-in returned no session');

  return signIn.session.access_token;
}

async function createTenant0(targetUrl: string): Promise<Credentials> {
  const superadminToken = await signInAsSuperadmin();

  const createRes = await fetch(`${targetUrl}/api/admin/tenants`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${superadminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: TENANT_NAME, fulfillment_quota: FULFILLMENT_QUOTA, admin_email: TENANT_ADMIN_EMAIL }),
  });
  if (!createRes.ok) throw new Error(`POST /api/admin/tenants failed: ${createRes.status} ${await createRes.text()}`);
  const created = (await createRes.json()) as {
    tenant: { id: string };
    invite: { invite_url: string };
    api_key: string;
  };

  const inviteToken = new URL(created.invite.invite_url).searchParams.get('token');
  if (!inviteToken) throw new Error(`Could not parse invite token out of ${created.invite.invite_url}`);

  const tenantAdminPassword = randomPassword();
  const acceptRes = await fetch(`${targetUrl}/api/invites/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inviteToken, password: tenantAdminPassword }),
  });
  if (!acceptRes.ok) throw new Error(`POST /api/invites/accept failed: ${acceptRes.status} ${await acceptRes.text()}`);

  // Prove the real tenant_admin login works end to end (SESSION_HANDOFF.md's
  // explicit ask — "since 04e presumably wants a working tenant_admin login
  // for dashboard-adjacent verification too"), not just that the invite
  // record flipped to accepted.
  const { data: tenantAdminSignIn, error: signInError } = await supabaseAdmin.auth.signInWithPassword({
    email: TENANT_ADMIN_EMAIL,
    password: tenantAdminPassword,
  });
  if (signInError || !tenantAdminSignIn.session) throw signInError ?? new Error('tenant_admin sign-in returned no session');

  const usageRes = await fetch(`${targetUrl}/v1/tenant/usage`, {
    headers: { Authorization: `Bearer ${tenantAdminSignIn.session.access_token}` },
  });
  if (!usageRes.ok) throw new Error(`tenant_admin login smoke check (GET /v1/tenant/usage) failed: ${usageRes.status} ${await usageRes.text()}`);
  console.log('tenant_admin login verified via GET /v1/tenant/usage:', await usageRes.json());

  const patchRes = await fetch(`${targetUrl}/api/admin/tenants/${created.tenant.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${superadminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reservation_timeout_seconds: RESERVATION_TIMEOUT_SECONDS }),
  });
  if (!patchRes.ok) throw new Error(`Failed to shorten reservation_timeout_seconds: ${patchRes.status} ${await patchRes.text()}`);

  return {
    tenant_id: created.tenant.id,
    tenant_api_key: created.api_key,
    tenant_admin_email: TENANT_ADMIN_EMAIL,
    tenant_admin_password: tenantAdminPassword,
  };
}

interface SeedCampaign {
  name: string;
  creative_media_path: string;
  obligation_type: 'impression_count' | 'share_of_voice';
  obligation_target: number;
  flight_start: string;
  flight_end: string;
  targeting: Campaign['targeting'];
  status: 'active';
}

function baselineCampaigns(): SeedCampaign[] {
  const now = new Date();
  const flightStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const flightEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  return [
    {
      name: 'Sim — Impression CA',
      creative_media_path: 'sim/impression-ca.mp4',
      obligation_type: 'impression_count',
      obligation_target: 500_000,
      flight_start: flightStart,
      flight_end: flightEnd,
      targeting: { geo: { type: 'state', values: ['CA'] } },
      status: 'active',
    },
    {
      name: 'Sim — SOV 60 TX',
      creative_media_path: 'sim/sov-60-tx.mp4',
      obligation_type: 'share_of_voice',
      obligation_target: 60,
      flight_start: flightStart,
      flight_end: flightEnd,
      targeting: { geo: { type: 'state', values: ['TX'] } },
      status: 'active',
    },
    {
      name: 'Sim — SOV 40 TX',
      creative_media_path: 'sim/sov-40-tx.mp4',
      obligation_type: 'share_of_voice',
      obligation_target: 40,
      flight_start: flightStart,
      flight_end: flightEnd,
      targeting: { geo: { type: 'state', values: ['TX'] } },
      status: 'active',
    },
    {
      // Deliberately NOT geo:'all'. reconciliation.ts's SOV pressure denominator
      // (computeTotalPoolDelivered) sums own_delivered across every campaign
      // *eligible for that request* — including impression-count ones — since
      // there's no per-targeting-scope ledger, only a global confirmed_count
      // per campaign (04c's build-report flagged the same limitation for the
      // dashboard's sov_actual approximation). An 'all'-geo fallback would be
      // eligible on TX requests too and pollute the SOV pair's pressure calc
      // with its much larger CA/everywhere-else volume, making the 60/40
      // convergence effectively unobservable in a short run. Enumerating every
      // state except CA/TX keeps the SOV pair's eligible pool clean/isolated,
      // matching test-plan.md's E2E-02 setup ("one screen matching both [SOV
      // campaigns]"), while still serving the bulk of the generic screen pool.
      name: 'Sim — Impression Fallback (non-CA/TX)',
      creative_media_path: 'sim/impression-fallback.mp4',
      obligation_type: 'impression_count',
      obligation_target: 500_000,
      flight_start: flightStart,
      flight_end: flightEnd,
      targeting: {
        geo: {
          type: 'state',
          // Every state in attribute-generator.ts's STATE_WEIGHTS pool except
          // CA and TX — kept in sync manually since k6/Node scripts don't
          // share imports across the simulator/ boundary here.
          values: [
            'FL', 'NY', 'PA', 'IL', 'OH', 'GA', 'NC', 'MI', 'NJ', 'VA',
            'WA', 'AZ', 'MA', 'TN', 'IN', 'MO', 'MD', 'WI', 'CO', 'MN',
            'SC', 'AL', 'LA', 'KY', 'OR', 'OK', 'CT', 'UT', 'NV', 'NM',
            'WV', 'NE', 'ID', 'ME', 'MT', 'VT', 'WY', 'AK',
          ],
        },
      },
      status: 'active',
    },
  ];
}

async function seedCampaigns(targetUrl: string, tenantApiKey: string) {
  const listRes = await fetch(`${targetUrl}/v1/campaigns`, { headers: { Authorization: `Bearer ${tenantApiKey}` } });
  if (!listRes.ok) throw new Error(`GET /v1/campaigns failed: ${listRes.status} ${await listRes.text()}`);
  const { campaigns } = (await listRes.json()) as { campaigns: Campaign[] };
  const existingByName = new Map(campaigns.map((c) => [c.name, c]));

  for (const seed of baselineCampaigns()) {
    const existing = existingByName.get(seed.name);
    if (existing) {
      // Upsert, not skip — keeps re-running seed.ts safe after this file's
      // campaign definitions change, not just after a from-scratch DB.
      const res = await fetch(`${targetUrl}/v1/campaigns/${existing.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tenantApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ obligation_target: seed.obligation_target, targeting: seed.targeting, status: seed.status }),
      });
      if (!res.ok) throw new Error(`Failed to update campaign "${seed.name}": ${res.status} ${await res.text()}`);
      console.log(`Updated campaign "${seed.name}" to match current seed definition.`);
      continue;
    }
    const res = await fetch(`${targetUrl}/v1/campaigns`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenantApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(seed),
    });
    if (!res.ok) throw new Error(`Failed to create campaign "${seed.name}": ${res.status} ${await res.text()}`);
    console.log(`Created campaign "${seed.name}".`);
  }
}

async function main() {
  const { targetUrl } = parseArgs();

  const { data: existingTenant } = await supabaseAdmin.from('tenants').select('id').eq('name', TENANT_NAME).maybeSingle();

  let credentials: Credentials;

  if (existingTenant) {
    if (!existsSync(OUTPUT_PATH)) {
      throw new Error(
        `Tenant "${TENANT_NAME}" (${existingTenant.id}) already exists in the DB but ${OUTPUT_PATH} is missing — ` +
          `credentials were generated in a prior session/machine and not carried over. Rotate the tenant API key ` +
          `via a superadmin-authenticated POST /v1/tenant/api-key/rotate call (or reset the tenant_admin's password ` +
          `via supabaseAdmin.auth.admin) to regain access, then write a fresh ${OUTPUT_PATH} by hand.`
      );
    }
    credentials = JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8'));
    console.log(`Tenant "${TENANT_NAME}" already exists (${credentials.tenant_id}), reusing saved credentials.`);
  } else {
    console.log(`Creating "${TENANT_NAME}" via the real superadmin -> invite-accept flow...`);
    credentials = await createTenant0(targetUrl);
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, JSON.stringify(credentials, null, 2));
    console.log(`Created "${TENANT_NAME}" (${credentials.tenant_id}). Credentials written to ${OUTPUT_PATH}.`);
  }

  await seedCampaigns(targetUrl, credentials.tenant_api_key);
  console.log('Seed complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
