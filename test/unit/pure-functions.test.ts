// TARGET-UNIT-01..08, RECON-UNIT-01..11, HASH-UNIT-01 — pure functions, no
// DB/network. test-plan.md § Unit Tests.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  matchesDaypart,
  matchesDayOfWeek,
  matchesGeo,
  matchesScreenConfig,
} from '../../server/targeting';
import {
  scoreSovPressure,
  scoreImpressionPressure,
  scoreEligiblePool,
  selectWinner,
  computeTotalPoolDelivered,
  type ScorableCampaign,
  type ScoredCandidate,
} from '../../server/reconciliation';

function utc(hhmm: string, day = '2026-01-05'): Date {
  return new Date(`${day}T${hhmm}:00.000Z`);
}

describe('targeting — daypart', () => {
  it('TARGET-UNIT-01: within window', () => {
    expect(matchesDaypart([{ start: '09:00', end: '17:00' }], utc('12:00'))).toBe(true);
  });

  it('TARGET-UNIT-02: outside window', () => {
    expect(matchesDaypart([{ start: '09:00', end: '17:00' }], utc('20:00'))).toBe(false);
  });

  it('TARGET-UNIT-03: overnight window wraps correctly', () => {
    const daypart = [{ start: '22:00', end: '02:00' }];
    expect(matchesDaypart(daypart, utc('23:30'))).toBe(true);
    expect(matchesDaypart(daypart, utc('01:00'))).toBe(true);
    expect(matchesDaypart(daypart, utc('12:00'))).toBe(false);
  });

  it('omitted daypart matches all day', () => {
    expect(matchesDaypart(undefined, utc('03:00'))).toBe(true);
  });
});

describe('targeting — day of week', () => {
  it('TARGET-UNIT-04: Mon-Fri excludes Saturday', () => {
    // 2026-01-03 is a Saturday.
    expect(matchesDayOfWeek([1, 2, 3, 4, 5], utc('12:00', '2026-01-03'))).toBe(false);
  });

  it('omitted days_of_week matches every day', () => {
    expect(matchesDayOfWeek(undefined, utc('12:00', '2026-01-03'))).toBe(true);
  });
});

describe('targeting — geo', () => {
  it('TARGET-UNIT-05: "all" matches regardless of screen location', () => {
    expect(matchesGeo({ type: 'all' }, { state: 'TX', zip: null })).toBe(true);
  });

  it('TARGET-UNIT-06: state list, no match', () => {
    expect(matchesGeo({ type: 'state', values: ['CA', 'NY'] }, { state: 'TX', zip: null })).toBe(false);
  });

  it('TARGET-UNIT-07: zip list match', () => {
    expect(matchesGeo({ type: 'zip', values: ['10001'] }, { state: null, zip: '10001' })).toBe(true);
  });
});

describe('targeting — screen config', () => {
  it('TARGET-UNIT-08: omitted dimensions impose no restriction', () => {
    const result = matchesScreenConfig(
      { aspect_ratios: ['16:9'] },
      { aspect_ratio: '16:9', resolution: '3840x2160', orientation: 'portrait' }
    );
    expect(result).toBe(true);
  });

  it('restricted dimension rejects a non-matching value', () => {
    const result = matchesScreenConfig(
      { aspect_ratios: ['16:9'] },
      { aspect_ratio: '4:3', resolution: '1024x768', orientation: 'landscape' }
    );
    expect(result).toBe(false);
  });
});

function campaign(overrides: Partial<ScorableCampaign> & Pick<ScorableCampaign, 'id' | 'obligation_type'>): ScorableCampaign {
  return {
    obligation_target: 1000,
    priority_weight: 1.0,
    flight_start: isoAt(-50),
    flight_end: isoAt(50),
    own_delivered: 0,
    ...overrides,
  };
}

function isoAt(minutesFromNow: number): string {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString();
}

describe('reconciliation — impression-count pacing pressure', () => {
  it('RECON-UNIT-01: behind pace', () => {
    const now = new Date();
    const c = campaign({
      id: 'a',
      obligation_type: 'impression_count',
      obligation_target: 1000,
      own_delivered: 400,
      flight_start: new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString(),
      flight_end: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(),
    });
    expect(scoreImpressionPressure(c, now)).toBeCloseTo(0.1, 5);
  });

  it('RECON-UNIT-02: ahead of pace', () => {
    const now = new Date();
    const c = campaign({
      id: 'a',
      obligation_type: 'impression_count',
      obligation_target: 1000,
      own_delivered: 600,
      flight_start: new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString(),
      flight_end: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(),
    });
    expect(scoreImpressionPressure(c, now)).toBeCloseTo(-0.1, 5);
  });
});

describe('reconciliation — SOV pacing pressure', () => {
  it('RECON-UNIT-03: computed against the whole pool, not sibling SOV only', () => {
    const sov = campaign({ id: 'b', obligation_type: 'share_of_voice', obligation_target: 40, own_delivered: 15 });
    const impression = campaign({ id: 'a', obligation_type: 'impression_count', obligation_target: 1000, own_delivered: 300 });
    const total = computeTotalPoolDelivered([sov, impression]);
    expect(total).toBe(315);
    const pressure = scoreSovPressure(sov, total);
    expect(pressure).toBeCloseTo(0.4 - 15 / 315, 5);
    expect(pressure).toBeCloseTo(0.352, 2);
  });

  it('RECON-UNIT-04: empty pool', () => {
    const sov = campaign({ id: 'b', obligation_type: 'share_of_voice', obligation_target: 40, own_delivered: 0 });
    const total = computeTotalPoolDelivered([sov]);
    expect(total).toBe(0);
    expect(scoreSovPressure(sov, total)).toBeCloseTo(0.4, 5);
  });
});

describe('reconciliation — two-tier scoring', () => {
  it('RECON-UNIT-05: behind-pace SOV wins over a higher-pressure impression-count campaign, unconditionally', () => {
    const now = new Date();
    const a = campaign({ id: 'a', obligation_type: 'impression_count', obligation_target: 1000, own_delivered: 300 });
    const b = campaign({ id: 'b', obligation_type: 'share_of_voice', obligation_target: 40, own_delivered: 15 });
    const result = scoreEligiblePool([a, b], now);
    expect(result.tier).toBe('sov_behind_pace');
    expect(result.winner?.id).toBe('b');

    // Variant: A's pressure deliberately higher than B's (own_delivered held
    // fixed at 300 so the total pool — and thus B's pressure — is unchanged;
    // A's pressure is instead raised via flight elapsed-fraction, nearly at
    // flight_end so expected_delivered approaches its target) — B still
    // wins, proving Tier 1 short-circuits Tier 2 rather than comparing
    // scores across tiers.
    const aHighPressure = campaign({
      id: 'a',
      obligation_type: 'impression_count',
      obligation_target: 1000,
      own_delivered: 300,
      flight_start: new Date(now.getTime() - 10_000 * 60_000).toISOString(),
      flight_end: new Date(now.getTime() + 1_000).toISOString(),
    });
    const result2 = scoreEligiblePool([aHighPressure, b], now);
    expect(result2.tier).toBe('sov_behind_pace');
    expect(result2.winner?.id).toBe('b');
  });

  it('RECON-UNIT-06: impression-count wins the remnant once SOV is satisfied, even with negative pressure', () => {
    const now = new Date();
    const a = campaign({ id: 'a', obligation_type: 'impression_count', obligation_target: 1000, own_delivered: 600 });
    const b = campaign({ id: 'b', obligation_type: 'share_of_voice', obligation_target: 40, own_delivered: 400 });
    // total = 1000, b actual_share = 0.40, pressure = 0.00 -> not > 0
    const result = scoreEligiblePool([a, b], now);
    expect(result.tier).toBe('impression_remnant');
    expect(result.winner?.id).toBe('a');
  });

  it('RECON-UNIT-07: satisfied SOV serves rather than leaving a slot empty (Tier 0′)', () => {
    const now = new Date();
    const b = campaign({ id: 'b', obligation_type: 'share_of_voice', obligation_target: 40, own_delivered: 40 });
    // Only campaign eligible; total pool delivered = 40, actual_share = 1.0, pressure negative.
    const result = scoreEligiblePool([b], now);
    expect(result.tier).toBe('sov_satisfied_fallback');
    expect(result.winner?.id).toBe('b');
  });

  it('RECON-UNIT-11: priority_weight never crosses tiers', () => {
    const now = new Date();
    const a = campaign({ id: 'a', obligation_type: 'impression_count', obligation_target: 1000, own_delivered: 300, priority_weight: 10.0 });
    // b barely behind pace: total pool small so pressure stays > 0 but tiny.
    const b = campaign({ id: 'b', obligation_type: 'share_of_voice', obligation_target: 1, own_delivered: 0, priority_weight: 0.1 });
    const result = scoreEligiblePool([a, b], now);
    expect(result.tier).toBe('sov_behind_pace');
    expect(result.winner?.id).toBe('b');
  });
});

describe('reconciliation — winner selection', () => {
  it('RECON-UNIT-08: outright win, no tie', () => {
    const x: ScoredCandidate = { campaign: campaign({ id: 'x', obligation_type: 'impression_count' }), pacingPressure: 0.35 };
    const y: ScoredCandidate = { campaign: campaign({ id: 'y', obligation_type: 'impression_count' }), pacingPressure: 0.10 };
    const winner = selectWinner([x, y], () => 0.999);
    expect(winner?.campaign.id).toBe('x');
  });

  it('RECON-UNIT-09: weighted-random tiebreak splits ~50/50 for equal weights', () => {
    const x: ScoredCandidate = { campaign: campaign({ id: 'x', obligation_type: 'impression_count', priority_weight: 1.0 }), pacingPressure: 0 };
    const y: ScoredCandidate = { campaign: campaign({ id: 'y', obligation_type: 'impression_count', priority_weight: 1.0 }), pacingPressure: 0 };
    let xWins = 0;
    const trials = 1000;
    // Deterministic seeded sequence via a simple LCG rather than Math.random,
    // so the test itself is reproducible.
    let seed = 42;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < trials; i++) {
      const winner = selectWinner([x, y], rng);
      if (winner?.campaign.id === 'x') xWins++;
    }
    expect(xWins / trials).toBeGreaterThan(0.45);
    expect(xWins / trials).toBeLessThan(0.55);
  });

  it('RECON-UNIT-10: priority-weighted tiebreak is not uniform', () => {
    const x: ScoredCandidate = { campaign: campaign({ id: 'x', obligation_type: 'impression_count', priority_weight: 2.0 }), pacingPressure: 0 };
    const y: ScoredCandidate = { campaign: campaign({ id: 'y', obligation_type: 'impression_count', priority_weight: 1.0 }), pacingPressure: 0 };
    let xWins = 0;
    const trials = 1000;
    let seed = 7;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < trials; i++) {
      const winner = selectWinner([x, y], rng);
      if (winner?.campaign.id === 'x') xWins++;
    }
    const ratio = xWins / (trials - xWins);
    expect(ratio).toBeGreaterThan(1.6);
    expect(ratio).toBeLessThan(2.4);
  });
});

describe('HASH-UNIT-01: device key hashing uses Web Crypto, not Node crypto', () => {
  it('server/hash.ts never imports Node\'s crypto module', () => {
    const source = readFileSync(new URL('../../server/hash.ts', import.meta.url), 'utf-8');
    expect(source).not.toMatch(/from ['"]crypto['"]/);
    expect(source).not.toMatch(/require\(['"]crypto['"]\)/);
    expect(source).toContain('globalThis.crypto.subtle');
  });
});
