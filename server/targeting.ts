// Targeting match logic — daypart / day-of-week / geo / screen-config.
// architecture.md § Data Model, `campaigns.targeting` JSONB shape. Evaluated
// per fulfillment request against a specific screen's static attributes; no
// SQL WHERE involved (targeting is always read as a whole from an
// already-loaded campaign row — see architecture.md's note on why `targeting`
// is a single JSONB column, not a normalized table).
//
// Daypart windows are evaluated in UTC (no per-screen timezone derivation —
// accepted MVP simplification per architecture.md). Multiple daypart windows
// are OR'd — a screen is in-daypart if the current time falls within *any*
// listed window (scope.md § explicit behaviors).

import type { CampaignTargeting, Screen } from '../types';

export type TargetingScreen = Pick<Screen, 'state' | 'zip' | 'aspect_ratio' | 'resolution' | 'orientation'>;

function minutesOfDay(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function matchesDaypart(daypart: { start: string; end: string }[] | undefined, now: Date): boolean {
  if (!daypart || daypart.length === 0) return true; // omitted = all day

  const nowMinutes = minutesOfDay(now);
  return daypart.some(({ start, end }) => {
    const startMinutes = hhmmToMinutes(start);
    const endMinutes = hhmmToMinutes(end);
    if (startMinutes <= endMinutes) {
      // Same-day window, e.g. 09:00–17:00.
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }
    // Overnight window, e.g. 22:00–02:00 — wraps past midnight.
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  });
}

export function matchesDayOfWeek(daysOfWeek: number[] | undefined, now: Date): boolean {
  if (!daysOfWeek || daysOfWeek.length === 0) return true; // omitted = every day

  const jsDay = now.getUTCDay(); // 0 (Sun) – 6 (Sat)
  const isoDay = jsDay === 0 ? 7 : jsDay; // ISO 1 (Mon) – 7 (Sun)
  return daysOfWeek.includes(isoDay);
}

export function matchesGeo(geo: CampaignTargeting['geo'], screen: Pick<TargetingScreen, 'state' | 'zip'>): boolean {
  if (geo.type === 'all') return true;
  if (geo.type === 'state') return !!screen.state && !!geo.values?.includes(screen.state);
  if (geo.type === 'zip') return !!screen.zip && !!geo.values?.includes(screen.zip);
  return false;
}

export function matchesScreenConfig(
  screenTargeting: CampaignTargeting['screen'],
  screen: Pick<TargetingScreen, 'aspect_ratio' | 'resolution' | 'orientation'>
): boolean {
  if (!screenTargeting) return true; // omitted entirely = unrestricted

  if (screenTargeting.aspect_ratios && !screenTargeting.aspect_ratios.includes(screen.aspect_ratio)) return false;
  if (screenTargeting.resolutions && !screenTargeting.resolutions.includes(screen.resolution)) return false;
  if (screenTargeting.orientations && !screenTargeting.orientations.includes(screen.orientation)) return false;
  return true;
}

// Pure structural check (no `now`, unlike the matches* functions above) —
// backs GET /v1/campaigns/:id/pacing's `no_eligible_screens` field
// (architecture.md § API Endpoints, follow-up scoping session). "Does this
// targeting's time window ever cover any nonzero span of a week" is a
// different question from "does it match right now" — CAMPAIGN-UNIT-03's
// flight/daypart validation should already reject a zero-width daypart at
// creation, but this exists as defense-in-depth (PACING-INT-03) rather than
// assuming validation always upstream-blocks it. String comparison of HH:MM
// values is sufficient: equal strings is exactly the zero-width case, and
// every other case (including an overnight wrap like 22:00–02:00) is a
// nonzero span.
export function hasNonZeroTimeCoverage(targeting: Pick<CampaignTargeting, 'daypart' | 'days_of_week'>): boolean {
  if (targeting.days_of_week && targeting.days_of_week.length === 0) return false;
  if (targeting.daypart && targeting.daypart.length > 0) {
    return targeting.daypart.some(({ start, end }) => start !== end);
  }
  return true;
}

export function matchesTargeting(targeting: CampaignTargeting, screen: TargetingScreen, now: Date = new Date()): boolean {
  return (
    matchesDaypart(targeting.daypart, now) &&
    matchesDayOfWeek(targeting.days_of_week, now) &&
    matchesGeo(targeting.geo, screen) &&
    matchesScreenConfig(targeting.screen, screen)
  );
}
