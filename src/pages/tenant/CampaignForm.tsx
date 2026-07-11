import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useCampaigns, useCreateCampaign, usePatchCampaign, type CampaignInput } from '@/hooks/useCampaigns';
import type { CampaignTargeting } from '@shared/index';
import { ApiError } from '@/lib/api';

const DAYS = [
  { iso: 1, label: 'Mon' },
  { iso: 2, label: 'Tue' },
  { iso: 3, label: 'Wed' },
  { iso: 4, label: 'Thu' },
  { iso: 5, label: 'Fri' },
  { iso: 6, label: 'Sat' },
  { iso: 7, label: 'Sun' },
];

function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocal(value: string): string {
  return new Date(value).toISOString();
}

function parseCsv(value: string): string[] | undefined {
  const values = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

interface DaypartWindow {
  start: string;
  end: string;
}

export default function CampaignForm() {
  const navigate = useNavigate();
  const { id } = useParams();
  const isEdit = !!id;

  const { data: campaigns } = useCampaigns();
  const existing = isEdit ? campaigns?.find((c) => c.id === id) : undefined;

  const createCampaign = useCreateCampaign();
  const patchCampaign = usePatchCampaign(id ?? '');

  const [name, setName] = React.useState('');
  const [creativeMediaPath, setCreativeMediaPath] = React.useState('');
  const [obligationType, setObligationType] = React.useState<'impression_count' | 'share_of_voice'>('impression_count');
  const [obligationTarget, setObligationTarget] = React.useState('');
  const [priorityWeight, setPriorityWeight] = React.useState('1');
  const [flightStart, setFlightStart] = React.useState('');
  const [flightEnd, setFlightEnd] = React.useState('');
  const [status, setStatus] = React.useState<'draft' | 'active' | 'paused' | 'archived'>('draft');

  const [geoType, setGeoType] = React.useState<'all' | 'state' | 'zip'>('all');
  const [geoValues, setGeoValues] = React.useState('');
  const [daypart, setDaypart] = React.useState<DaypartWindow[]>([]);
  const [daysOfWeek, setDaysOfWeek] = React.useState<Set<number>>(new Set());
  const [aspectRatios, setAspectRatios] = React.useState('');
  const [resolutions, setResolutions] = React.useState('');
  const [orientations, setOrientations] = React.useState<Set<'landscape' | 'portrait'>>(new Set());

  const [error, setError] = React.useState<string | null>(null);
  const [loadedFromExisting, setLoadedFromExisting] = React.useState(false);

  // Route param + tanstack-query cache both resolve async — gate the
  // one-time hydration behind a flag so an edit doesn't silently start from
  // blank defaults if `existing` arrives a tick after mount (same TipTap-style
  // "gate behind a ready flag" lesson from CLAUDE.md's fox-ricciardi notes).
  React.useEffect(() => {
    if (isEdit && existing && !loadedFromExisting) {
      setName(existing.name);
      setCreativeMediaPath(existing.creative_media_path);
      setObligationType(existing.obligation_type);
      setObligationTarget(String(existing.obligation_target));
      setPriorityWeight(String(existing.priority_weight));
      setFlightStart(toDatetimeLocal(existing.flight_start));
      setFlightEnd(toDatetimeLocal(existing.flight_end));
      setStatus(existing.status);

      const targeting: CampaignTargeting = existing.targeting;
      setGeoType(targeting.geo?.type ?? 'all');
      setGeoValues((targeting.geo?.values ?? []).join(', '));
      setDaypart(targeting.daypart ?? []);
      setDaysOfWeek(new Set(targeting.days_of_week ?? []));
      setAspectRatios((targeting.screen?.aspect_ratios ?? []).join(', '));
      setResolutions((targeting.screen?.resolutions ?? []).join(', '));
      setOrientations(new Set(targeting.screen?.orientations ?? []));

      setLoadedFromExisting(true);
    }
  }, [isEdit, existing, loadedFromExisting]);

  function toggleDay(iso: number) {
    setDaysOfWeek((prev) => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
  }

  function toggleOrientation(value: 'landscape' | 'portrait') {
    setOrientations((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function addDaypartWindow() {
    setDaypart((prev) => [...prev, { start: '09:00', end: '17:00' }]);
  }

  function updateDaypartWindow(index: number, field: 'start' | 'end', value: string) {
    setDaypart((prev) => prev.map((w, i) => (i === index ? { ...w, [field]: value } : w)));
  }

  function removeDaypartWindow(index: number) {
    setDaypart((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const screenTargeting =
      aspectRatios || resolutions || orientations.size > 0
        ? {
            aspect_ratios: parseCsv(aspectRatios),
            resolutions: parseCsv(resolutions),
            orientations: orientations.size > 0 ? Array.from(orientations) : undefined,
          }
        : undefined;

    const targeting: CampaignTargeting = {
      geo: { type: geoType, values: geoType === 'all' ? undefined : parseCsv(geoValues) },
      daypart: daypart.length > 0 ? daypart : undefined,
      days_of_week: daysOfWeek.size > 0 ? Array.from(daysOfWeek).sort() : undefined,
      screen: screenTargeting,
    };

    const body: CampaignInput = {
      name,
      creative_media_path: creativeMediaPath,
      obligation_type: obligationType,
      obligation_target: Number(obligationTarget),
      priority_weight: Number(priorityWeight),
      flight_start: fromDatetimeLocal(flightStart),
      flight_end: fromDatetimeLocal(flightEnd),
      targeting,
      status,
    };

    try {
      if (isEdit) {
        await patchCampaign.mutateAsync(body);
      } else {
        await createCampaign.mutateAsync(body);
      }
      navigate('/t/campaigns');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SOV_OVERSOLD') {
        const current = err.body?.current_combined_total as number | undefined;
        setError(`This would push the tenant's combined active SOV target over 100% (currently ${current ?? '?'}%). Lower this campaign's target or another active SOV campaign's target.`);
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to save campaign');
      }
    }
  }

  const submitting = createCampaign.isPending || patchCampaign.isPending;

  if (isEdit && !loadedFromExisting) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader>
        <CardTitle>{isEdit ? 'Edit campaign' : 'New campaign'}</CardTitle>
        <CardDescription>Obligation, targeting, creative reference, and flight window.</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-6">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="media-path">Creative media path</Label>
              <Input
                id="media-path"
                required
                placeholder="bucket/path/to/creative.mp4"
                value={creativeMediaPath}
                onChange={(e) => setCreativeMediaPath(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Obligation type</Label>
              <Select value={obligationType} onValueChange={(v) => setObligationType(v as typeof obligationType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="impression_count">Impression count</SelectItem>
                  <SelectItem value="share_of_voice">Share of voice</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="obligation-target">
                {obligationType === 'impression_count' ? 'Target impressions' : 'Target share (%)'}
              </Label>
              <Input
                id="obligation-target"
                type="number"
                required
                min={0}
                max={obligationType === 'share_of_voice' ? 100 : undefined}
                value={obligationTarget}
                onChange={(e) => setObligationTarget(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="priority">Priority weight</Label>
              <Input
                id="priority"
                type="number"
                step="0.1"
                min={0}
                value={priorityWeight}
                onChange={(e) => setPriorityWeight(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="flight-start">Flight start</Label>
              <Input
                id="flight-start"
                type="datetime-local"
                required
                value={flightStart}
                onChange={(e) => setFlightStart(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="flight-end">Flight end</Label>
              <Input
                id="flight-end"
                type="datetime-local"
                required
                value={flightEnd}
                onChange={(e) => setFlightEnd(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-4 border-t pt-4">
            <h3 className="text-sm font-medium">Targeting</h3>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Geography</Label>
                <Select value={geoType} onValueChange={(v) => setGeoType(v as typeof geoType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="state">States</SelectItem>
                    <SelectItem value="zip">Zip codes</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {geoType !== 'all' && (
                <div className="space-y-1.5">
                  <Label htmlFor="geo-values">{geoType === 'state' ? 'States (comma-separated)' : 'Zips (comma-separated)'}</Label>
                  <Input
                    id="geo-values"
                    placeholder={geoType === 'state' ? 'CA, NY' : '10001, 10002'}
                    value={geoValues}
                    onChange={(e) => setGeoValues(e.target.value)}
                  />
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Days of week (none selected = every day)</Label>
              <div className="flex flex-wrap gap-2">
                {DAYS.map((day) => (
                  <button
                    type="button"
                    key={day.iso}
                    onClick={() => toggleDay(day.iso)}
                    className={
                      'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ' +
                      (daysOfWeek.has(day.iso) ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent')
                    }
                  >
                    {day.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Daypart windows (none = all day)</Label>
                <Button type="button" size="sm" variant="outline" onClick={addDaypartWindow}>
                  Add window
                </Button>
              </div>
              {daypart.map((window, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input type="time" value={window.start} onChange={(e) => updateDaypartWindow(i, 'start', e.target.value)} />
                  <span className="text-sm text-muted-foreground">to</span>
                  <Input type="time" value={window.end} onChange={(e) => updateDaypartWindow(i, 'end', e.target.value)} />
                  <Button type="button" size="sm" variant="ghost" onClick={() => removeDaypartWindow(i)}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="aspect-ratios">Aspect ratios (comma-separated, blank = any)</Label>
                <Input id="aspect-ratios" placeholder="16:9, 9:16" value={aspectRatios} onChange={(e) => setAspectRatios(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="resolutions">Resolutions (comma-separated, blank = any)</Label>
                <Input id="resolutions" placeholder="1920x1080" value={resolutions} onChange={(e) => setResolutions(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Orientation (none selected = any)</Label>
              <div className="flex gap-2">
                {(['landscape', 'portrait'] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    onClick={() => toggleOrientation(value)}
                    className={
                      'rounded-md border px-2.5 py-1 text-xs font-medium capitalize transition-colors ' +
                      (orientations.has(value) ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent')
                    }
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
        <CardFooter className="gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create campaign'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate('/t/campaigns')}>
            Cancel
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
