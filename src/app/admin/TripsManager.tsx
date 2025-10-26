'use client';

import { useState } from 'react';
import { TripStopBuilder } from './TripStopBuilder';

type Trip = { id: string; name: string; code?: string | null; company_id: string; created_at?: string };

export function TripsManager(props: { trips: Trip[] }) {
  const { trips } = props;
  const [openTripId, setOpenTripId] = useState<string | null>(null);

  if (!openTripId) {
    return (
      <div className="overflow-x-auto">
        <table className="table text-sm">
          <thead>
            <tr className="text-left">
              <th>Name</th>
              <th>Code</th>
              <th>Company</th>
              <th>Created</th>
              <th>Builder</th>
            </tr>
          </thead>
          <tbody>
            {(trips || []).map((t: any) => (
              <tr key={t.id}>
                <td className="font-medium">{t.name}</td>
                <td className="font-mono">{t.code || '—'}</td>
                <td className="font-mono">{t.company_id}</td>
                <td>{t.created_at ? new Date(t.created_at).toLocaleString() : '—'}</td>
                <td>
                  <button className="btn btn-outline h-8 px-3" onClick={() => setOpenTripId(t.id)}>Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!trips || trips.length === 0) && (
          <div className="text-sm text-muted p-3">Create a trip to start adding stops.</div>
        )}
      </div>
    );
  }

  const trip = trips.find(t => t.id === openTripId) || null;
  if (!trip) {
    setOpenTripId(null);
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-muted">Stops for</div>
          <div className="font-medium">{trip.name} {trip.code ? `(${trip.code})` : ''}</div>
        </div>
        <button className="btn" onClick={() => setOpenTripId(null)}>Done</button>
      </div>
      <TripStopBuilder tripId={trip.id} />
    </div>
  );
}


