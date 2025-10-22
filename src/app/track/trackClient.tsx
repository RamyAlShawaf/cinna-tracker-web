'use client';

import dynamic from 'next/dynamic';
const MapContainer = dynamic(() => import('react-leaflet').then(m => m.MapContainer), { ssr: false }) as any;
const TileLayer = dynamic(() => import('react-leaflet').then(m => m.TileLayer), { ssr: false }) as any;
const Marker = dynamic(() => import('react-leaflet').then(m => m.Marker), { ssr: false }) as any;
const Popup = dynamic(() => import('react-leaflet').then(m => m.Popup), { ssr: false }) as any;
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const isRetina = typeof window !== 'undefined' && window.devicePixelRatio > 1;
const defaultIcon = new L.Icon({
    iconUrl: isRetina
        ? 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png'
        : 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41],
});

// Sleek pulsing circle marker icon
const pulseIcon = L.divIcon({
    className: 'pulse-icon',
    html: '<div class="pulse-dot"></div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -12],
});

interface TrackClientProps {
	code: string;
}

interface LivePoint {
	lat: number;
	lng: number;
	speed?: number | null;
	heading?: number | null;
	accuracy?: number | null;
	ts?: string;
}

export default function TrackClient({ code }: TrackClientProps) {
	const [point, setPoint] = useState<LivePoint | null>(null);
	const [vehicleId, setVehicleId] = useState<string | null>(null);
	const [status, setStatus] = useState<string>('');
  const mapRef = useRef<any>(null);
    const maptilerKey = process.env.NEXT_PUBLIC_MAPTILER_KEY;
    const mapStyle = process.env.NEXT_PUBLIC_MAP_STYLE || 'basic-v2-dark';
    const usingMapTiler = !!maptilerKey;
    const tileUrl = usingMapTiler
        ? `https://api.maptiler.com/maps/${mapStyle}/{z}/{x}/{y}@2x.png?key=${maptilerKey}`
        : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    const attribution = usingMapTiler
        ? '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
	const supabase = useMemo(() => {
		const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
		const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
		return createClient(url, anon);
	}, []);
	const timerRef = useRef<NodeJS.Timeout | null>(null);

	useEffect(() => {
		let mounted = true;
		async function prime() {
			if (!code) return;
			setStatus('Loading last position…');
			const r = await fetch(`/api/vehicle/${encodeURIComponent(code)}/last`);
			if (r.ok) {
				const data = await r.json();
				if (mounted) setPoint(data);
			}
			// Lookup vehicle id for realtime subscription via Postgres changes
			const { data: v } = await supabase
				.from('vehicles')
				.select('id')
				.eq('public_code', code)
				.single();
			if (v?.id && mounted) setVehicleId(v.id);
			setStatus('');
		}
		prime();
		return () => {
			mounted = false;
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [code]);

	useEffect(() => {
		if (!vehicleId) return;
		// Subscribe to Postgres changes on vehicle_live for this vehicle
		const channel = supabase
			.channel(`live:${vehicleId}`)
			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'vehicle_live', filter: `vehicle_id=eq.${vehicleId}` },
				(payload: any) => {
					const row = (payload.new || payload.record) as any;
					if (!row) return;
					setPoint({
						lat: row.lat,
						lng: row.lng,
						speed: row.speed,
						heading: row.heading,
						accuracy: row.accuracy,
						ts: row.ts,
					});
				}
			)
			.subscribe();

		// Fallback: mark offline if no updates for 60s
		timerRef.current && clearInterval(timerRef.current);
		timerRef.current = setInterval(() => {
			if (!point?.ts) return;
			const age = Date.now() - new Date(point.ts).getTime();
			if (age > 60_000) setStatus('Bus may be offline');
			else setStatus('');
		}, 5_000);

		return () => {
			channel.unsubscribe();
			if (timerRef.current) clearInterval(timerRef.current);
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [vehicleId, supabase]);

  useEffect(() => {
    if (mapRef.current && point) {
      mapRef.current.setView([point.lat, point.lng], 15);
    }
  }, [point]);

	return (
		<div className="w-full h-full">
			<div className="mb-2 flex items-center gap-3">
				<input
					defaultValue={code}
					placeholder="Enter vehicle code (e.g., ONX-102)"
					className="border rounded px-3 py-2"
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							const target = e.target as HTMLInputElement;
							const newCode = target.value.trim();
							if (newCode) window.location.search = `?v=${encodeURIComponent(newCode)}`;
						}
					}}
				/>
				<div className="text-sm text-gray-600">{status}</div>
			</div>
      {!point ? (
        <div style={{ height: 'calc(100% - 40px)', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="text-sm text-gray-600">Waiting for first location…</span>
        </div>
      ) : (
        <MapContainer
          center={[point.lat, point.lng] as [number, number]}
          zoom={15}
          whenCreated={(m: any) => {
            mapRef.current = m;
            m.setView([point.lat, point.lng], 15);
          }}
          style={{ height: 'calc(100% - 40px)', width: '100%' }}
        >
          <TileLayer
            attribution={attribution}
            url={tileUrl}
            detectRetina={!usingMapTiler}
            tileSize={usingMapTiler ? 512 : undefined as any}
            zoomOffset={usingMapTiler ? -1 : undefined as any}
          />
          <Marker position={[point.lat, point.lng] as [number, number]} icon={pulseIcon}>
            <Popup>
              <div className="text-sm">
                <div>Lat: {point.lat.toFixed(5)}, Lng: {point.lng.toFixed(5)}</div>
                {point.speed != null && <div>Speed: {Math.round(point.speed)} m/s</div>}
                {point.ts && <div>Last seen: {new Date(point.ts).toLocaleTimeString()}</div>}
              </div>
            </Popup>
          </Marker>
        </MapContainer>
      )}
      <style jsx global>{`
        /* Make Leaflet divIcon transparent */
        .leaflet-div-icon.pulse-icon {
          background: transparent;
          border: none;
        }
        .pulse-icon .pulse-dot {
          width: 18px;
          height: 18px;
          background: #14b8a6; /* teal-500 */
          border: 2px solid #ffffff;
          border-radius: 9999px;
          box-shadow: 0 0 0 rgba(20, 184, 166, 0.5);
          position: relative;
        }
        .pulse-icon .pulse-dot::after {
          content: '';
          position: absolute;
          left: 50%;
          top: 50%;
          width: 100%;
          height: 100%;
          border-radius: 9999px;
          transform: translate(-50%, -50%) scale(1);
          background: rgba(20, 184, 166, 0.35);
          animation: pulse-ring 1.8s ease-out infinite;
        }
        @keyframes pulse-ring {
          0% {
            transform: translate(-50%, -50%) scale(1);
            opacity: 0.75;
          }
          100% {
            transform: translate(-50%, -50%) scale(2.8);
            opacity: 0;
          }
        }
      `}</style>
		</div>
	);
}
