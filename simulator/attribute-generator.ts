// Generates N virtual screens and registers each via the real
// `POST /v1/screens` (a tenant API key, never a direct DB insert — this file
// doubles as a functional exerciser of the real registration endpoint, per
// architecture.md's "Virtual Screen Simulator" framing). Two layers, per
// scope.md's Agent 03 flag ("a 'realistic' distribution and an
// 'edge-case-covering' distribution pull in different directions; MVP
// requires both, not one traded off against the other"):
//
//   1. Guaranteed coverage — at least MIN_PER_COMBO (default 3) screens for
//      every distinct targeting combination (geo value, screen config value)
//      used by the target tenant's currently-active campaigns, so targeting
//      edge cases are never silently untested no matter how the random pool
//      lands.
//   2. Realistic distribution — the remainder of the requested count, drawn
//      from a population-weighted US state list and a small realistic set of
//      aspect ratio / resolution / orientation combos, not uniform random
//      (uniform would cluster in a way that never stresses low-density
//      geos/configs).
//
// Generic and tenant-agnostic — reusable by any tenant's simulator run, not
// hardcoded to Tenant 0 (that wiring lives in seed.ts). Also the seed of
// 04g's load-generation tool per architecture.md, so it takes plain
// count/rate-shaped inputs now rather than anything Tenant-0-specific.
//
// Usage:
//   npx tsx simulator/attribute-generator.ts \
//     --target-url http://localhost:3010 \
//     --tenant-api-key tenant_xxx \
//     --count 60 \
//     --min-per-combo 3 \
//     --out simulator/.output/screens.json

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Campaign, CampaignTargeting } from '../types';

interface GeneratedScreen {
  label: string;
  state: string | null;
  zip: string | null;
  aspect_ratio: string;
  resolution: string;
  orientation: 'landscape' | 'portrait';
}

interface RegisteredScreen extends GeneratedScreen {
  screen_id: string;
  device_api_key: string;
}

// Population-weighted, not exhaustive — enough spread across high- and
// low-density states that a uniform-random draw's clustering problem
// (scope.md's flag) doesn't apply. Weight is relative, not a percentage.
const STATE_WEIGHTS: [string, number][] = [
  ['CA', 12], ['TX', 9], ['FL', 7], ['NY', 6], ['PA', 4],
  ['IL', 4], ['OH', 4], ['GA', 3], ['NC', 3], ['MI', 3],
  ['NJ', 3], ['VA', 3], ['WA', 3], ['AZ', 2], ['MA', 2],
  ['TN', 2], ['IN', 2], ['MO', 2], ['MD', 2], ['WI', 2],
  ['CO', 2], ['MN', 2], ['SC', 2], ['AL', 1], ['LA', 1],
  ['KY', 1], ['OR', 1], ['OK', 1], ['CT', 1], ['UT', 1],
  ['NV', 1], ['NM', 1], ['WV', 1], ['NE', 1], ['ID', 1],
  ['ME', 1], ['MT', 1], ['VT', 1], ['WY', 1], ['AK', 1],
];

const SCREEN_CONFIGS: { aspect_ratio: string; resolution: string; orientation: 'landscape' | 'portrait' }[] = [
  { aspect_ratio: '16:9', resolution: '1920x1080', orientation: 'landscape' },
  { aspect_ratio: '16:9', resolution: '3840x2160', orientation: 'landscape' },
  { aspect_ratio: '9:16', resolution: '1080x1920', orientation: 'portrait' },
  { aspect_ratio: '4:3', resolution: '1024x768', orientation: 'landscape' },
  { aspect_ratio: '21:9', resolution: '2560x1080', orientation: 'landscape' },
];

function weightedPick<T>(weighted: [T, number][]): T {
  const total = weighted.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * total;
  for (const [value, weight] of weighted) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return weighted[weighted.length - 1][0];
}

function randomZip(): string {
  return String(10000 + Math.floor(Math.random() * 89999));
}

function randomScreenLabel(seq: number): string {
  return `Sim Screen ${String(seq).padStart(4, '0')}`;
}

function realisticScreen(seq: number): GeneratedScreen {
  const state = weightedPick(STATE_WEIGHTS);
  const config = SCREEN_CONFIGS[Math.floor(Math.random() * SCREEN_CONFIGS.length)];
  return {
    label: randomScreenLabel(seq),
    state,
    zip: Math.random() < 0.3 ? randomZip() : null,
    ...config,
  };
}

/** Every distinct concrete attribute value referenced by any active
 * campaign's targeting — daypart/days_of_week are excluded, since neither is
 * a screen attribute (they're evaluated against request time, not anything a
 * screen carries). */
function extractGuaranteedCombos(campaigns: Campaign[]): {
  states: Set<string>;
  zips: Set<string>;
  aspectRatios: Set<string>;
  resolutions: Set<string>;
  orientations: Set<'landscape' | 'portrait'>;
} {
  const states = new Set<string>();
  const zips = new Set<string>();
  const aspectRatios = new Set<string>();
  const resolutions = new Set<string>();
  const orientations = new Set<'landscape' | 'portrait'>();

  for (const c of campaigns) {
    if (c.status !== 'active') continue;
    const t: CampaignTargeting = c.targeting;
    if (t.geo?.type === 'state') for (const v of t.geo.values ?? []) states.add(v);
    if (t.geo?.type === 'zip') for (const v of t.geo.values ?? []) zips.add(v);
    for (const v of t.screen?.aspect_ratios ?? []) aspectRatios.add(v);
    for (const v of t.screen?.resolutions ?? []) resolutions.add(v);
    for (const v of t.screen?.orientations ?? []) orientations.add(v);
  }

  return { states, zips, aspectRatios, resolutions, orientations };
}

function guaranteedScreensFor(
  combos: ReturnType<typeof extractGuaranteedCombos>,
  minPerCombo: number,
  seqStart: number
): GeneratedScreen[] {
  const screens: GeneratedScreen[] = [];
  let seq = seqStart;

  // One guaranteed screen set per distinct value, not per cross-product —
  // crossing every geo value against every screen-config value would
  // over-generate for tenants with several campaigns. Each guaranteed screen
  // still draws a realistic config/state for the dimension it isn't pinning,
  // so it also contributes to the general distribution.
  for (const state of combos.states) {
    for (let i = 0; i < minPerCombo; i++) {
      const config = SCREEN_CONFIGS[Math.floor(Math.random() * SCREEN_CONFIGS.length)];
      screens.push({ label: randomScreenLabel(seq++), state, zip: null, ...config });
    }
  }
  for (const zip of combos.zips) {
    for (let i = 0; i < minPerCombo; i++) {
      const config = SCREEN_CONFIGS[Math.floor(Math.random() * SCREEN_CONFIGS.length)];
      screens.push({ label: randomScreenLabel(seq++), state: null, zip, ...config });
    }
  }
  for (const aspect_ratio of combos.aspectRatios) {
    for (let i = 0; i < minPerCombo; i++) {
      const state = weightedPick(STATE_WEIGHTS);
      const orientation = aspect_ratio === '9:16' ? 'portrait' : 'landscape';
      const resolution = SCREEN_CONFIGS.find((cfg) => cfg.aspect_ratio === aspect_ratio)?.resolution ?? '1920x1080';
      screens.push({ label: randomScreenLabel(seq++), state, zip: null, aspect_ratio, resolution, orientation });
    }
  }
  for (const orientation of combos.orientations) {
    for (let i = 0; i < minPerCombo; i++) {
      const state = weightedPick(STATE_WEIGHTS);
      const config = SCREEN_CONFIGS.find((cfg) => cfg.orientation === orientation) ?? SCREEN_CONFIGS[0];
      screens.push({ label: randomScreenLabel(seq++), state, zip: null, aspect_ratio: config.aspect_ratio, resolution: config.resolution, orientation });
    }
  }

  return screens;
}

interface Args {
  targetUrl: string;
  tenantApiKey: string;
  count: number;
  minPerCombo: number;
  out: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : fallback;
  };

  const targetUrl = get('--target-url', process.env.K6_TARGET_URL);
  const tenantApiKey = get('--tenant-api-key', process.env.TENANT_API_KEY);
  if (!targetUrl) throw new Error('--target-url (or K6_TARGET_URL) is required');
  if (!tenantApiKey) throw new Error('--tenant-api-key (or TENANT_API_KEY) is required');

  return {
    targetUrl,
    tenantApiKey,
    count: Number(get('--count', '60')),
    minPerCombo: Number(get('--min-per-combo', '3')),
    out: get('--out', 'simulator/.output/screens.json') as string,
  };
}

async function registerScreen(targetUrl: string, tenantApiKey: string, screen: GeneratedScreen): Promise<RegisteredScreen> {
  const res = await fetch(`${targetUrl}/v1/screens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenantApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...screen, is_simulated: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to register screen "${screen.label}": ${res.status} ${body}`);
  }
  const json = (await res.json()) as { screen: { id: string }; device_api_key: string };
  return { ...screen, screen_id: json.screen.id, device_api_key: json.device_api_key };
}

async function main() {
  const args = parseArgs();

  const campaignsRes = await fetch(`${args.targetUrl}/v1/campaigns`, {
    headers: { Authorization: `Bearer ${args.tenantApiKey}` },
  });
  if (!campaignsRes.ok) {
    throw new Error(`Failed to fetch campaigns for targeting-combo coverage: ${campaignsRes.status} ${await campaignsRes.text()}`);
  }
  const { campaigns } = (await campaignsRes.json()) as { campaigns: Campaign[] };

  const combos = extractGuaranteedCombos(campaigns);
  const guaranteed = guaranteedScreensFor(combos, args.minPerCombo, 1);

  const remainingCount = Math.max(args.count - guaranteed.length, 0);
  const realistic: GeneratedScreen[] = [];
  for (let i = 0; i < remainingCount; i++) {
    realistic.push(realisticScreen(guaranteed.length + i + 1));
  }

  const toGenerate = [...guaranteed, ...realistic];
  console.log(
    `Registering ${toGenerate.length} screens (${guaranteed.length} guaranteed-coverage + ${realistic.length} realistic-distribution) against ${args.targetUrl}...`
  );

  const registered: RegisteredScreen[] = [];
  for (const screen of toGenerate) {
    const result = await registerScreen(args.targetUrl, args.tenantApiKey, screen);
    registered.push(result);
  }

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(registered, null, 2));
  console.log(`Registered ${registered.length} screens. Wrote device keys to ${args.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
