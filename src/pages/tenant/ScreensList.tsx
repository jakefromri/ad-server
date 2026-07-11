import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { useScreens, useCreateScreen, usePatchScreen, useRotateScreenKey, type ScreenInput } from '@/hooks/useScreens';
import { ApiError } from '@/lib/api';
import type { ScreenWithKey } from '@/lib/api-types';

function RegisterScreenDialog({ open, onOpenChange, onKeyIssued }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onKeyIssued: (key: string) => void;
}) {
  const createScreen = useCreateScreen();
  const [form, setForm] = React.useState<ScreenInput>({
    label: '',
    state: '',
    zip: '',
    aspect_ratio: '16:9',
    resolution: '1920x1080',
    orientation: 'landscape',
  });
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { device_api_key } = await createScreen.mutateAsync({
        ...form,
        state: form.state || null,
        zip: form.zip || null,
      });
      onOpenChange(false);
      onKeyIssued(device_api_key);
      setForm({ label: '', state: '', zip: '', aspect_ratio: '16:9', resolution: '1920x1080', orientation: 'landscape' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to register screen');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register screen</DialogTitle>
          <DialogDescription>Issues a device API key, shown once after creation.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="screen-label">Label</Label>
            <Input id="screen-label" required value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="screen-state">State (2-letter)</Label>
              <Input
                id="screen-state"
                maxLength={2}
                value={form.state ?? ''}
                onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="screen-zip">Zip</Label>
              <Input id="screen-zip" value={form.zip ?? ''} onChange={(e) => setForm({ ...form, zip: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="screen-aspect">Aspect ratio</Label>
              <Input
                id="screen-aspect"
                required
                value={form.aspect_ratio}
                onChange={(e) => setForm({ ...form, aspect_ratio: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="screen-resolution">Resolution</Label>
              <Input
                id="screen-resolution"
                required
                value={form.resolution}
                onChange={(e) => setForm({ ...form, resolution: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Orientation</Label>
              <Select value={form.orientation} onValueChange={(v) => setForm({ ...form, orientation: v as ScreenInput['orientation'] })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="landscape">Landscape</SelectItem>
                  <SelectItem value="portrait">Portrait</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={createScreen.isPending}>
              {createScreen.isPending ? 'Registering…' : 'Register'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeviceKeyRevealDialog({ apiKey, onClose }: { apiKey: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!apiKey} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Device key</DialogTitle>
          <DialogDescription>Shown once. Copy it now — it won't be retrievable again.</DialogDescription>
        </DialogHeader>
        <code className="block break-all rounded-md bg-muted p-3 text-sm">{apiKey}</code>
        <DialogFooter>
          <Button onClick={() => apiKey && navigator.clipboard.writeText(apiKey)} variant="outline">
            Copy
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScreenRow({ screen }: { screen: ScreenWithKey }) {
  const patchScreen = usePatchScreen(screen.id);
  const rotateKey = useRotateScreenKey(screen.id);
  const [revealedKey, setRevealedKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function toggleStatus() {
    setError(null);
    try {
      await patchScreen.mutateAsync({ status: screen.status === 'active' ? 'inactive' : 'active' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update screen');
    }
  }

  async function handleRotate() {
    setError(null);
    try {
      const { device_api_key } = await rotateKey.mutateAsync();
      setRevealedKey(device_api_key);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to rotate key');
    }
  }

  return (
    <TableRow>
      <TableCell className="font-medium">
        {screen.label}
        {screen.is_simulated && (
          <Badge variant="secondary" className="ml-2">
            simulated
          </Badge>
        )}
      </TableCell>
      <TableCell>{screen.state ?? screen.zip ?? '—'}</TableCell>
      <TableCell>
        {screen.aspect_ratio} · {screen.resolution} · {screen.orientation}
      </TableCell>
      <TableCell>
        <Badge variant={screen.status === 'active' ? 'success' : 'outline'}>{screen.status}</Badge>
      </TableCell>
      <TableCell>
        <span title="Marking a screen 'inactive' is a labeling signal only — it does not revoke the device key or block requests. Rotate the key to actually cut off a screen.">
          {screen.device_key_prefix ? `${screen.device_key_prefix}…` : '—'} ({screen.device_key_status})
        </span>
      </TableCell>
      <TableCell className="text-right">
        {error && <div className="mb-1 text-xs text-destructive">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={patchScreen.isPending} onClick={toggleStatus}>
            {screen.status === 'active' ? 'Mark inactive' : 'Mark active'}
          </Button>
          <Button size="sm" variant="outline" disabled={rotateKey.isPending} onClick={handleRotate}>
            Rotate key
          </Button>
        </div>
      </TableCell>
      <DeviceKeyRevealDialog apiKey={revealedKey} onClose={() => setRevealedKey(null)} />
    </TableRow>
  );
}

export default function ScreensList() {
  const { data: screens, isLoading, error } = useScreens();
  const [registerOpen, setRegisterOpen] = React.useState(false);
  const [issuedKey, setIssuedKey] = React.useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Screens</h1>
          <p className="text-sm text-muted-foreground">Registered inventory, real and simulator-created.</p>
        </div>
        <Button onClick={() => setRegisterOpen(true)}>Register screen</Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error instanceof Error ? error.message : 'Failed to load screens'}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : screens && screens.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Config</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Device key</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {screens.map((screen) => (
              <ScreenRow key={screen.id} screen={screen} />
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">No screens yet. Register one to get started.</p>
      )}

      <RegisterScreenDialog open={registerOpen} onOpenChange={setRegisterOpen} onKeyIssued={setIssuedKey} />
      <DeviceKeyRevealDialog apiKey={issuedKey} onClose={() => setIssuedKey(null)} />
    </div>
  );
}
