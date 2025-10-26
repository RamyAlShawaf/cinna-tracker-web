'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Place = {
  id: string;
  name: string;
  address?: string;
  lat: number;
  lng: number;
};

type Stop = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  sequence: number;
  dwell_seconds: number | null;
};

export function TripStopBuilder(props: { tripId: string }) {
  const { tripId } = props;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [loading, setLoading] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchStops = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/trips/${encodeURIComponent(tripId)}/stops/list`, { cache: 'no-store' });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || 'Failed to load stops');
      setStops(json.stops || []);
    } catch (e) {
      // noop minimal UX
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => {
    void fetchStops();
  }, [fetchStops]);

  const doSearch = useCallback(async () => {
    if (!query.trim()) { setResults([]); return; }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const r = await fetch(`/api/places/search?q=${encodeURIComponent(query)}`, { signal: ctrl.signal });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || 'Search failed');
      setResults(json.results || []);
    } catch (e) {
      if ((e as any)?.name !== 'AbortError') {
        setResults([]);
      }
    }
  }, [query]);

  useEffect(() => {
    const t = setTimeout(() => { void doSearch(); }, 250);
    return () => clearTimeout(t);
  }, [query, doSearch]);

  const nextSequence = useMemo(() => (stops.length ? Math.max(...stops.map(s => s.sequence)) + 1 : 1), [stops]);

  const addStop = useCallback(async (p: Place) => {
    setAddingId(p.id);
    try {
      const r = await fetch(`/api/trips/${encodeURIComponent(tripId)}/stops/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: p.name, lat: p.lat, lng: p.lng, sequence: nextSequence }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || 'Add stop failed');
      await fetchStops();
    } catch (e) {
      // noop minimal UX
    } finally {
      setAddingId(null);
    }
  }, [tripId, nextSequence, fetchStops]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
        <div>
          <label className="block text-sm mb-1 text-muted">Search places</label>
          <input value={query} onChange={e => setQuery(e.target.value)} className="input" placeholder="Search by name or address" />
        </div>
      </div>

      {results.length > 0 && (
        <div className="rounded border border-[var(--border)]">
          <div className="p-2 text-xs text-muted">Search results</div>
          <ul className="divide-y divide-[var(--border)]">
            {results.map(p => (
              <li key={p.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted truncate">{p.address || `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`}</div>
                </div>
                <button
                  className="btn btn-outline h-8"
                  onClick={() => { void addStop(p); }}
                  disabled={addingId === p.id}
                >{addingId === p.id ? 'Adding…' : `Add #${nextSequence}`}</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded border border-[var(--border)]">
        <div className="p-2 text-xs text-muted">Stops ({stops.length})</div>
        <ul className="divide-y divide-[var(--border)]">
          {(stops || []).map(s => (
            <StopRow key={s.id} tripId={tripId} stop={s} onChanged={fetchStops} />
          ))}
          {stops.length === 0 && (
            <li className="p-3 text-sm text-muted">No stops yet. Search above to add the first one.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

function StopRow(props: { tripId: string; stop: Stop; onChanged: () => void }) {
  const { tripId, stop, onChanged } = props;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(stop.name);
  const [dwell, setDwell] = useState(stop.dwell_seconds ?? 0);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const r = await fetch(`/api/trips/${encodeURIComponent(tripId)}/stops/${encodeURIComponent(stop.id)}/update`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, dwell_seconds: dwell }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || 'Update failed');
      setEditing(false);
      onChanged();
    } catch {
      // noop
    } finally {
      setSaving(false);
    }
  }, [tripId, stop.id, name, dwell, onChanged]);

  const del = useCallback(async () => {
    if (!confirm('Delete this stop?')) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/trips/${encodeURIComponent(tripId)}/stops/${encodeURIComponent(stop.id)}/delete`, {
        method: 'DELETE',
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || 'Delete failed');
      onChanged();
    } catch {
      // noop
    } finally {
      setDeleting(false);
    }
  }, [tripId, stop.id, onChanged]);

  return (
    <li className="p-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        {!editing ? (
          <>
            <div className="font-medium truncate">#{stop.sequence} · {stop.name}</div>
            <div className="text-xs text-muted">{stop.lat.toFixed(5)}, {stop.lng.toFixed(5)} · dwell {stop.dwell_seconds ?? 0}s</div>
          </>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input className="input" value={name} onChange={e => setName(e.target.value)} />
            <input className="input" type="number" min={0} value={dwell} onChange={e => setDwell(parseInt(e.target.value || '0', 10))} />
            <div className="flex gap-2">
              <button className="btn btn-primary h-8" onClick={() => { void save(); }} disabled={saving}>Save</button>
              <button className="btn h-8" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
            </div>
          </div>
        )}
      </div>
      {!editing && (
        <div className="flex items-center gap-2">
          <button className="btn btn-outline h-8" onClick={() => setEditing(true)}>Edit</button>
          <button className="text-red-500" onClick={() => { void del(); }} disabled={deleting}>Delete</button>
        </div>
      )}
    </li>
  );
}


