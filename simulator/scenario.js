// k6 scenario: each virtual user (VU) is one simulated screen, running
// request -> wait -> report -> loop against a real ad-server deployment.
// Device count and request rate are k6 CLI options (--vus, --duration) —
// this same script is the seed of 04g's load-generation tool per
// architecture.md's "Virtual Screen Simulator" section, so nothing here is
// hardcoded to 04e's functional-test scale.
//
// Reads device keys from ./.output/screens.json, written by
// attribute-generator.ts (run that first). Requires --vus <= the number of
// screens generated for one-VU-per-screen fidelity; if --vus exceeds it,
// multiple VUs share a screen's device key, which still exercises the
// server correctly but no longer models "one screen, one identity."
//
// Usage:
//   K6_TARGET_URL=http://localhost:3010 \
//     k6 run --vus 60 --duration 2m -e K6_TARGET_URL=$K6_TARGET_URL simulator/scenario.js
//
// (k6 does not auto-import real OS environment variables into __ENV — pass
// -e explicitly, as above, or rely on the http://localhost:3010 fallback.)

import http from 'k6/http';
import { sleep, check } from 'k6';
import { SharedArray } from 'k6/data';

const screens = new SharedArray('screens', function () {
  return JSON.parse(open('./.output/screens.json'));
});

const BASE_URL = __ENV.K6_TARGET_URL || 'http://localhost:3010';
// Should match (or undershoot) the target tenant's actual
// reservation_timeout_seconds — seed.ts sets Tenant 0's to 20s specifically
// so a moderate-duration functional run can exercise the expiry path without
// waiting the architecture.md default of 300s.
const RESERVATION_TIMEOUT_SECONDS = Number(__ENV.RESERVATION_TIMEOUT_SECONDS || 20);

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function screenFor(vu) {
  return screens[(vu - 1) % screens.length];
}

export default function () {
  const screen = screenFor(__VU);
  const headers = { Authorization: `Bearer ${screen.device_api_key}`, 'Content-Type': 'application/json' };

  const res = http.post(`${BASE_URL}/v1/fulfillments`, null, { headers });

  if (res.status === 201) {
    const body = res.json();
    check(body, { 'fulfillment has an id': (b) => !!b.fulfillment_id });

    const outcomeRoll = Math.random();

    if (outcomeRoll < 0.07) {
      // Deliberately never report — lets the reservation expire, exercising
      // the release/expiry path (a small fraction of VUs, per
      // SESSION_HANDOFF.md's note that most requests should stay comfortably
      // under the timeout while a deliberate fraction crosses it).
      sleep(RESERVATION_TIMEOUT_SECONDS + randomBetween(2, 8));
      return;
    }

    // Placeholder wait — media_ref is only a bucket path string, with no
    // parseable duration (Campaign has no creative-duration field anywhere
    // in architecture.md's data model), so this is the documented fallback:
    // a fixed/randomized wait comfortably under the reservation timeout.
    const waitSeconds = randomBetween(2, Math.max(3, RESERVATION_TIMEOUT_SECONDS - 5));
    sleep(waitSeconds);

    const outcome = outcomeRoll < 0.15 ? (Math.random() < 0.5 ? 'skipped' : 'failed') : 'played';
    const reportRes = http.post(
      `${BASE_URL}/v1/fulfillments/${body.fulfillment_id}/report`,
      JSON.stringify({ outcome, played_duration_ms: Math.round(waitSeconds * 1000) }),
      { headers }
    );
    check(reportRes, { 'report accepted': (r) => r.status === 200 });
  } else if (res.status === 200) {
    // { fulfilled: false, reason: 'no_eligible_campaigns' } — genuinely no
    // eligible campaign right now, not a race loss (the endpoint's own
    // attempt loop already retries up to 3 times internally for that case).
    // Back off and try again next tick rather than hammering — the one case
    // 04d's build-report flagged the simulator as needing its own retry
    // logic for.
    sleep(randomBetween(3, 6));
  } else if (res.status === 429) {
    // Quota exhausted — back off longer rather than spinning against a wall.
    sleep(randomBetween(8, 15));
  } else {
    console.error(`Unexpected response ${res.status}: ${res.body}`);
    sleep(randomBetween(3, 6));
  }

  sleep(randomBetween(1, 3));
}
