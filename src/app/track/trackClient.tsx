'use client';

import dynamic from 'next/dynamic';
const MapContainer = dynamic(() => import('react-leaflet').then(m => m.MapContainer), { ssr: false });
const TileLayer = dynamic(() => import('react-leaflet').then(m => m.TileLayer), { ssr: false });
const Marker = dynamic(() => import('react-leaflet').then(m => m.Marker), { ssr: false });
const Popup = dynamic(() => import('react-leaflet').then(m => m.Popup), { ssr: false });
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const defaultIcon = new L.Icon({
	iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
	shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
	iconSize: [25, 41],
	iconAnchor: [12, 41],
	popupAnchor: [1, -34],
	shadowSize: [41, 41],
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

	const center = point ? [point.lat, point.lng] as [number, number] : [37.7749, -122.4194];
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
			<MapContainer center={center} zoom={14} style={{ height: 'calc(100% - 40px)', width: '100%' }}>
				<TileLayer
					attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
					url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
				/>
				{point && (
					<Marker position={[point.lat, point.lng]} icon={defaultIcon}>
						<Popup>
							<div className="text-sm">
								<div>Lat: {point.lat.toFixed(5)}, Lng: {point.lng.toFixed(5)}</div>
								{point.speed != null && <div>Speed: {Math.round(point.speed)} m/s</div>}
								{point.ts && <div>Last seen: {new Date(point.ts).toLocaleTimeString()}</div>}
							</div>
						</Popup>
					</Marker>
				)}
			</MapContainer>
		</div>
	);
}
