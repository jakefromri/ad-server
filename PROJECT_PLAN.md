# ad-server — project plan

> **Stack:** Ralph Loop default (React + TS + Vite, Hono on Vercel, Supabase Postgres + Auth) for
> the control plane (tenants, campaigns, screens, dashboard) — with the fulfillment hot path and
> its scale story deliberately left open for Agent 02 to evaluate, not assumed. See "key design
> decisions" below.
>
> **Ralph Loop:** Run this project through all 7 agents. Real architecture decisions — multi-tenant
> auth, a from-scratch reconciliation/pacing engine, machine-to-machine device auth, and a
> 100k-req/min scale target — warrant the full loop, not a shortcut.

---

## product vision

A multi-tenant ad-serving API for digital signage / DOOH inventory. Tenants define campaigns as
obligations (fixed impression counts or share-of-voice percentages) with targeting constraints
(daypart, day of week, geography, screen configuration). Screens — real eventually, virtual for
now — call in for an ad, get back a reference to a media file in a public bucket, play it, and
report back. A ledger tracks what played and what's left on every campaign's obligation in real
time. Tenants are onboarded with an API-key and a fulfillment quota; the eventual goal is an
architecture that holds up at 100,000 requests/minute.

The hardest and most novel part of this build isn't CRUD — it's the reconciliation engine (pacing
multiple competing obligation types against each other) and the virtualization harness needed to
prove it out and load-test it, since there's no physical hardware to test against.

---

## key design decisions (resolve before Agent 02)

| Decision | Recommendation | Rationale |
|----------|---------------|-----------|
| Compute for the fulfillment hot path | Start on the Ralph Loop default (Hono on Vercel, Edge runtime) for MVP correctness; re-evaluate against real numbers in Agent 04g | Don't guess the scale-appropriate platform before measuring. Edge functions avoid Node cold-starts but a long-running service (Fly.io/Railway) may win at sustained 1,667+ req/sec — that's an Agent 02/04g decision, not a scope decision |
| Campaign eligibility lookups | Cache each tenant's active campaign set in memory/Redis, invalidated on campaign CRUD or short TTL, instead of a Postgres query per fulfillment request | A DB round-trip per request is the first thing that breaks at high req/sec; campaign definitions change far less often than fulfillment requests arrive |
| Ledger writes | Reservation writes stay synchronous (correctness-critical — this is what prevents double-serving obligation); report/confirmation writes can move to an async queue once 04g shows write contention | Don't add queue infrastructure before there's evidence it's needed |
| Device auth | Per-device API key (hashed at rest, `globalThis.crypto.subtle.digest`, not Node `crypto` — Edge runtime constraint), separate from Supabase Auth entirely | Devices are machines, not users; forcing them through a human auth flow (JWT sessions, magic links) adds complexity with no benefit |
| Human auth (superadmin / tenant_admin) | Reuse the ComposableAuth pattern from `hello-world` — Supabase Auth, JWT `app_metadata.tenant_id` + `role`, IDs only | Proven pattern across Noticeboard/Lineup/Hello World; no reason to deviate for the dashboard side of this app |
| Media bucket | Any public bucket works — Supabase Storage public bucket is the default (no new infra) — the ad server treats the path as an opaque string | The ad server's job is reconciliation, not file storage; don't build storage tooling that isn't needed |
| Device simulator tooling | Build on k6 (preferred) or Artillery with a scripted scenario, not a bespoke Node harness | It has to serve two purposes without a rewrite: functional testing at low N during 04e, and load generation toward 100k req/min during 04g |
| App topology | Single Vite app with role-gated routes (tenant dashboard + superadmin console in one app), per the fox-ricciardi lesson that single-app beats multi-app when there isn't a hard reason to split | This app is read-heavy admin/reporting, not a complex multi-portal product — no reason to pay the ComposableAuth multi-port overhead |

---

## ralph loop — agent-by-agent breakdown

### agent 01 — scope
**Tool:** Claude Cowork
**Inputs:** Raw idea (this session)
**Outputs:** `scope.md`, `idea.md`

Done when: `scope.md` exists and Jake has confirmed the open questions table (already resolved
with reasonable defaults per CLAUDE.md autonomy preference — flag any Jake wants to change).

---

### agent 02 — architecture
**Tool:** Claude Cowork
**Inputs:** `scope.md`
**Outputs:** `architecture.md` + `test-plan.md`

Key things to design:
- **Data model:** `tenants`, `campaigns`, `campaign_targeting` (daypart windows, DOW, geo list,
  screen-config constraints — likely JSONB on the campaign row rather than a separate table, TBD),
  `screens`, `device_api_keys`, `fulfillments` (the ledger — id, tenant_id, campaign_id, screen_id,
  media_ref, status: `reserved` / `confirmed` / `expired` / `failed`, requested_at, reported_at,
  played_duration_ms), `fulfillment_quota_usage`
- **Reconciliation algorithm, precisely specified:** eligibility filter (targeting match + in-flight
  + has remaining obligation) → scoring function per obligation type (pacing deficit for
  impression-count, share deficit for SOV competing within the same eligible pool) → priority
  weight as tiebreaker → weighted-random selection among near-ties. Write this as pseudocode or a
  worked example with numbers — it's the part most likely to have subtle bugs.
- **Reservation/expiry mechanics:** how a reservation is written at fulfillment time, what
  triggers expiry sweep (lazy check on next read vs. a cron job), and what "released back to pool"
  means for obligation math
- **RLS:** two policies per tenant-scoped table (`superadmin_all` + `tenant_members_read_own`) per
  the standing Ralph Loop convention; device API-key auth bypasses RLS via service role, so
  authorization for device-facing endpoints must be enforced in the API layer, not RLS
- **Quota enforcement point:** checked before the reconciliation engine runs, so a request over
  quota never touches campaign scoring
- **Scale plan (informational, not built in MVP):** where caching, async writes, and platform
  choice would change as load increases — write this even though Agent 04g is what actually tests
  it, so there's a plan to test against

Done when: `architecture.md` covers all of the above with a worked reconciliation example, and
`test-plan.md` has a test per MVP behavior in `scope.md`.

---

### agent 03 — adversarial review
**Tool:** Claude Cowork
**Inputs:** `scope.md` + `architecture.md`
**Outputs:** Revised `architecture.md` (or list of issues to address)

Focus areas to stress-test:
- **Reconciliation fairness under low traffic:** does a low-volume tenant's SOV campaign ever
  converge, or does the math only work at high request volume? What happens with exactly one
  eligible campaign (no competition)?
- **Reservation race conditions:** two near-simultaneous fulfillment requests for the same
  screen — can they double-reserve the same unit of obligation? Does the DB transaction/locking
  strategy actually prevent it?
- **Expiry sweep correctness:** a screen that never reports back — does its reservation reliably
  return to the pool, or can obligation "leak" (permanently lost, never reserved or released)?
- **Quota edge cases:** what happens exactly at the quota boundary — is the request that hits the
  limit rejected or served? Off-by-one risk.
- **Targeting edge cases:** a campaign with no matching screens ever — does it silently never
  deliver with no operator-visible signal? Overlapping daypart windows on the same campaign?
- **Device key compromise:** what's the blast radius if one device's API key leaks — can it be
  used to exhaust a tenant's whole quota, forge reports for other screens, or read other tenants'
  data?
- **Simulator realism:** does spoofed/randomized attribute distribution actually exercise the
  targeting logic (geo/daypart/config diversity), or will it cluster in a way that never tests
  edge cases?

Done when: all issues are either resolved in architecture or explicitly accepted as known risks
(mirrors the SOV-precision limitation already accepted in `scope.md`).

---

### agent 04 — builder
**Tool:** Claude Cowork (file I/O) + Claude CLI (git)
**Inputs:** `scope.md` + `architecture.md`
**Outputs:** Working codebase, deployed to dev

This project clears the phased-builder threshold from the Ralph Loop README (more than 8 tables
once targeting/quota/keys are counted, plus a genuinely novel scoring algorithm and a dedicated
load-testing tool) — split into sub-sessions rather than one pass, same lesson as Meridian.

**04a — foundation**
- Fork `skunkworks/hello-world` (ComposableAuth scaffold) as baseline
- Schema migrations: `tenants`, `campaigns`, `screens`, `fulfillments`, `fulfillment_quota_usage`,
  `device_api_keys`
- RLS policies (`superadmin_all` + `tenant_members_read_own` per tenant-scoped table)
- Shared TypeScript types, `.env.example` + `.env`, Supabase dev project linked
- Done: `npm install` works, `supabase db push` succeeds

**04b — auth + device identity**
- Supabase Auth for superadmin / tenant_admin (ComposableAuth invite flow, reused as-is)
- Device API-key issuance at screen registration; hashed storage via
  `globalThis.crypto.subtle.digest` (Edge-runtime safe, per Lineup lesson — no Node `crypto`)
- Auth middleware distinguishing human sessions (JWT) from device requests (API key header)
- Done: tenant_admin can log in; a registered device can authenticate against a test endpoint;
  an invalid/revoked key is rejected

**04c — campaign + screen CRUD**
- Campaign create/edit/pause/archive endpoints (obligation type, targeting rules, creative
  reference, flight window, priority)
- Screen registration endpoint
- Quota-check middleware wired in (not yet enforced against fulfillment — that's 04d)
- Done: every endpoint testable via curl, correct tenant scoping verified

**04d — reconciliation engine + fulfillment/report API** (highest-risk phase — keep isolated)
- Eligibility filter: targeting match + in-flight + remaining obligation
- Scoring function per obligation type (pacing deficit / SOV deficit) + priority weight +
  weighted-random tiebreak, exactly as specified in `architecture.md`
- `POST /v1/fulfillments`: reserve + return media reference
- `POST /v1/fulfillments/:id/report`: confirm or release reservation
- Reservation expiry sweep
- Quota enforcement now active on the fulfillment endpoint
- Done: seeded-campaign unit tests show correct winner selection and correct ledger state
  transitions for both obligation types, including the race-condition and expiry cases Agent 03
  flagged

**04e — virtual screen simulator**
- k6 (or Artillery) scenario script: registers N virtual screens with randomized/spoofed
  attributes (state/zip, aspect ratio, resolution), runs a request → wait(simulated creative
  duration) → report loop, configurable device count and request rate
- Done: running 50–100 simulated screens against dev produces plausible, attribute-diverse
  traffic, and the ledger shows correct pacing convergence for both an impression-count campaign
  and a competing pair of SOV campaigns

**04f — tenant dashboard + superadmin console**
- Single Vite app, role-gated routes: tenant view (campaign pacing table, screen list, quota
  usage, API key) and superadmin view (tenant list, quota admin, cross-tenant volume)
- Done: a tenant_admin can see live campaign pacing in a browser; a superadmin can create a
  tenant and set its quota

**04g — load testing & scale hardening**
- Run the 04e simulator at increasing device counts / request rates against the dev deploy,
  climbing toward the 100k req/min target
- Identify the actual bottleneck (Postgres connection limits, function cold starts, eligibility
  query cost) and apply the specific mitigation flagged for it in `architecture.md` (caching,
  async ledger writes, platform change)
- Time-boxed: the deliverable is a documented, *measured* throughput ceiling and a concrete plan
  to close any remaining gap to 100k req/min — not necessarily hitting 100k inside this build
- Done: a written result (`load-test-report.md`) stating req/min achieved, where it broke, and
  what would need to change to go further
- **Note (added after the fact, in the 04f follow-up scoping session — see 04i below):** this
  phase ran in parallel with that scoping session, so its `load-test-report.md` numbers predate
  and don't include 04i's `fulfillment_attempts` async write (added to the fulfillment hot path
  for `GET /api/admin/system-health`). Accepted gap, not a blocker — see 04i's sequencing note.

**04h — tests + HANDOVER.md**
- Unit + integration test suite (per CLAUDE.md — never skip this; Meridian's lesson was that
  skipping it converts a 1-hour job into a 3–4 hour bug hunt), including an end-to-end flow test:
  create tenant → create campaign → simulate a screen → confirm ledger converges toward the
  campaign's obligation
- `HANDOVER.md` written per CLAUDE.md convention (live URL, repo, stack rationale, reconciliation
  algorithm summary, non-goals, anything that would trip up a cold session)
- Add `HANDOVER.md` and `idea.md` to `.gitignore`; confirm `scope.md` / `architecture.md` /
  `adversarial-report.md` / `test-plan.md` / `load-test-report.md` are also gitignored before the
  first commit (Lineup lesson — these are Ralph Loop working docs, not public documentation, and
  this repo is likely public)
- **Note (added after the fact, in the 04f follow-up scoping session):** if this phase also runs
  before 04i lands, its test suite won't yet cover 04i's new endpoints/fields — fine, since 04i has
  its own test-plan coverage and its own pass through this phase's "done" criteria isn't required
  again, but a re-run of `npm run typecheck`/`npm run lint` after 04i is still worth doing before
  the eventual first commit's gitignore check above.

**04i — admin follow-up scope** *(added in a dedicated follow-up scoping session that ran after 04f
and in parallel with 04g/04h — see `build-report.md`'s 04f "Recommended follow-up scope" for the
original gap list, and the Data Model / API Endpoints sections of `architecture.md` for the
resolved designs referenced below. Numbered last, after 04g/04h, since those two phases were
already in flight by the time this scope was worked through — not because this work is lower
priority than either)*
- `GET /api/admin/system-health` — add the `fulfillment_attempts` table (Data Model) and switch
  `api/index.ts`'s Vercel export from `handle(app)` to a custom handler that forwards
  `ExecutionContext`, so `POST /v1/fulfillments` can log one row per call via `c.executionCtx.waitUntil(...)`
  without adding hot-path latency
- `POST /api/admin/tenants/:id/reinvite` and `GET /api/admin/tenants/:id` (combined
  tenant+campaigns+screens detail) — both pure additions, no existing behavior changes
- `GET /v1/tenant/usage/by-screen` — new windowed aggregation endpoint over the existing
  `fulfillments` table; add the composite index architecture.md specifies
  (`fulfillments_tenant_screen_requested_idx`)
- `GET /v1/campaigns/:id/pacing`'s new `no_eligible_screens` field — live structural check inside
  the existing handler, no schema change
- `docs.ts` — convert every route in `api/lib/*.ts` from plain-Zod validation to
  `@hono/zod-openapi`'s `createRoute`/`OpenAPIHono` pattern; mount `GET /v1/openapi.json` and
  `GET /docs`. This is the largest single sub-item in this phase (touches every route file) —
  consider running it last within this phase, or as its own sub-session, since it's mechanical
  and doesn't depend on the other four
- Frontend: wire `/admin/health`, `/admin/tenants/:id`'s real sub-views (replacing the list-cache
  workaround noted in 04f's deviations), the reinvite action, the per-screen usage table on
  `/t/usage`, the `no_eligible_screens` badge on `/t/campaigns`, and un-stub the `/docs` link on
  `/t/settings`
- **Sequencing note (revised — 04g already ran before this scope existed):** the original intent
  was for `fulfillment_attempts` to land *before* load testing, so `load-test-report.md` would be
  a trustworthy final number including its write overhead. That's no longer possible — 04g already
  ran in parallel with this scoping session, without this table. Accepted as-is: `fulfillment_attempts`
  is async (`waitUntil`, off the response's critical path) and, per the Scale Plan table, is at
  worst a second write stream roughly `fulfillments`-sized at true 100k req/min — a candidate
  bottleneck, not a certain one. If it matters, a targeted follow-up load-test run (not a full
  04g re-run) is the way to check, not a hard gate on shipping this phase.
- Done: all six items from `build-report.md`'s 04f follow-up list are either built per the
  designs in `architecture.md`, or (none currently) explicitly cut with reasoning recorded here.
  Covers `test-plan.md`'s new cases (`ADMIN-INT-06` through `09`, `PACING-INT-01` through `04`,
  `USAGE-INT-01` through `03`, `OPENAPI-UNIT-01`, `FULFILL-ATTEMPT-INT-01`, `DOCS-INT-01`), which
  should also be folded into 04h's test suite if 04h hasn't run yet, or added to it afterward if it
  has

---

### agent 05 — QA
**Tool:** Claude CLI
**Inputs:** `test-plan.md` + deployed dev URL
**Outputs:** QA report, bug list

Test focus:
- Reconciliation correctness: seeded scenario where two SOV campaigns (60/40 target) converge to
  roughly that ratio over a realistic request volume
- Impression-count campaign correctly stops serving at zero remaining obligation
- Expired/unreported reservations correctly return to the pool (no obligation leakage)
- Targeting exclusion: a campaign with mismatched geo/daypart/screen-config never serves to an
  ineligible screen
- Quota enforcement: requests beyond a tenant's allotted fulfillments are rejected with a clear
  error, not silently served
- Device auth: revoked/invalid API key rejected; one tenant's device cannot read another tenant's
  data
- Review `04g`'s load-test-report.md findings against the original 100k req/min target

Done when: all test-plan cases pass or bugs are filed in Linear.

---

### agent 06 — deploy
**Tool:** Claude CLI
**Inputs:** Passing QA on dev
**Outputs:** Production deploy + verified

Steps (per CLAUDE.md deploy sequence):
1. Push DB migrations to prod Supabase project
2. Set prod env vars in Vercel (Supabase prod keys, device-key hashing secret, media bucket base
   URL)
3. PR from `dev` → `main`, merge
4. Verify the full loop on prod: create a real tenant, run a small simulator batch against prod
   to confirm the fulfillment/report/ledger cycle works end to end

**Operational rule:** never run the load-testing simulator (04g-scale volumes) against prod — it
burns real tenant quota and is a dev/staging-only tool. A small smoke-test batch for deploy
verification is fine; a load test is not.

Done when: the full loop works on the prod URL and a real tenant could be onboarded.

---

### agent 07 — iteration
**Tool:** Claude Cowork
**Inputs:** Post-launch observations
**Outputs:** Updated `scope.md` with v2 features

Likely v2 candidates:
- Two-sided marketplace model — separate publisher (screen owner) and advertiser tenants sharing
  inventory, rather than one tenant owning both
- Real device/player SDK for physical hardware, alongside the simulator
- Billing/invoicing built on the existing quota-usage data
- Frequency capping and real audience measurement (verified viewership, not just confirmed plays)
- Dynamic targeting beyond daypart/DOW/geo/screen-config (weather, live events)
- Multi-region active-active deployment
- Richer campaign-management UI (bulk operations, creative preview, pacing charts)
- A read-only reporting role, once there's a real second stakeholder per tenant

Done when: v2 scope is prioritized and ready for a new loop.

---

## file structure (target — confirm/adjust in Agent 02)

```
skunkworks/ad-server/
  PROJECT_PLAN.md          ← this file
  scope.md                 ← Agent 01 output
  architecture.md          ← Agent 02 output
  test-plan.md             ← Agent 02 output
  adversarial-report.md    ← Agent 03 output
  load-test-report.md      ← Agent 04g output
  HANDOVER.md              ← Agent 04h output (gitignored)
  idea.md                  ← (gitignored)
  src/                      # dashboard app (tenant + superadmin, role-gated routes)
    components/
    pages/
    lib/
    hooks/
  api/                      # Hono routes on Vercel Edge
    campaigns.ts
    screens.ts
    fulfillments.ts         # includes /report
    tenants.ts
    lib/
      reconciliation.ts     # the scoring/eligibility engine
      device-auth.ts
  simulator/                # k6/Artillery scenario + virtual screen generator
    scenario.js
    attribute-generator.ts
  supabase/
    migrations/
  package.json
  vite.config.ts
  vercel.json               ← SPA catch-all rewrite required
  .env.example
  .gitignore
```

---

## env vars needed

| Variable | Description |
|----------|--------------|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role (serverless only, no `VITE_` prefix) |
| `DEVICE_KEY_HASH_SECRET` | Pepper for hashing device API keys at rest |
| `MEDIA_BUCKET_BASE_URL` | Public bucket base URL used to construct/validate media references |
| `K6_TARGET_URL` | Base URL the simulator hits — dev/staging only, never prod for load runs |

---

## linear

Create a parent issue in the **Foxricciardi** team: **"New project: ad-server"**
Child issues per agent (01–07), with Agent 04 broken into 04a–04i sub-issues per the phases above.
Not set up yet for ad-server — deferred until past MVP stability, same pattern as other skunkworks
projects.
Status lifecycle: Backlog → In Progress → In Review → Done.
