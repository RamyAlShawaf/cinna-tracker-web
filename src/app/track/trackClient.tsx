'use client';

import dynamic from 'next/dynamic';
const MapContainer = dynamic(() => import('react-leaflet').then(m => m.MapContainer), { ssr: false }) as any;
const TileLayer = dynamic(() => import('react-leaflet').then(m => m.TileLayer), { ssr: false }) as any;
const Marker = dynamic(() => import('react-leaflet').then(m => m.Marker), { ssr: false }) as any;
const Popup = dynamic(() => import('react-leaflet').then(m => m.Popup), { ssr: false }) as any;
const Polyline = dynamic(() => import('react-leaflet').then(m => m.Polyline), { ssr: false }) as any;
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

interface TrackClientProps {
	code: string;
	showInput?: boolean;
}

interface LivePoint {
	lat: number;
	lng: number;
	speed?: number | null;
	heading?: number | null;
	accuracy?: number | null;
  status?: 'online' | 'paused';
	ts?: string;
  route?: { coordinates?: Array<{ lat: number; lng: number }> } | null;
}

export default function TrackClient({ code, showInput = true }: TrackClientProps) {
	const [point, setPoint] = useState<LivePoint | null>(null);
	const [vehicleId, setVehicleId] = useState<string | null>(null);
	const [vehicleLabel, setVehicleLabel] = useState<string | null>(null);
	const [status, setStatus] = useState<string>('');
	const [leaflet, setLeaflet] = useState<any>(null);
	const [isDark, setIsDark] = useState(true);
	const mapRef = useRef<any>(null);
	const maptilerKey = process.env.NEXT_PUBLIC_MAPTILER_KEY;
	const mapStyleDark = process.env.NEXT_PUBLIC_MAP_STYLE_DARK || process.env.NEXT_PUBLIC_MAP_STYLE || 'basic-v2-dark';
	const mapStyleLight = process.env.NEXT_PUBLIC_MAP_STYLE_LIGHT || 'basic-v2';
	const usingMapTiler = !!maptilerKey;

	// React to system theme to pick map style
	useEffect(() => {
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		setIsDark(mq.matches);
		const handler = (e: MediaQueryListEvent) => setIsDark(e.matches);
		mq.addEventListener('change', handler);
		return () => mq.removeEventListener('change', handler);
	}, []);

	const tileUrl = usingMapTiler
		? `https://api.maptiler.com/maps/${isDark ? mapStyleDark : mapStyleLight}/{z}/{x}/{y}@2x.png?key=${maptilerKey}`
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
		(async () => {
			const mod = await import('leaflet');
			if (mounted) setLeaflet((mod as any).default ?? mod);
		})();
		return () => { mounted = false; };
	}, []);

	const pulseIcon = useMemo(() => {
		if (!leaflet) return null;
		return leaflet.divIcon({
			className: 'pulse-icon',
			html: '<div class="pulse-dot"></div>',
			iconSize: [28, 28],
			iconAnchor: [14, 14],
			popupAnchor: [0, -12],
		});
	}, [leaflet]);

	useEffect(() => {
		let mounted = true;
		async function prime() {
			if (!code) return;
			setStatus('Loading last position…');
			const r = await fetch(`/api/vehicle/${encodeURIComponent(code)}/last`);
			if (r.ok) {
				const data = await r.json();
				if (mounted) setPoint(data);
			} else {
				// No live row -> offline
				if (mounted) {
					setPoint(null);
					setStatus('Offline');
				}
			}
			const { data: v } = await supabase
				.from('vehicles')
				.select('id,label')
				.eq('public_code', code)
				.single();
			if (v?.id && mounted) {
				setVehicleId(v.id);
				setVehicleLabel((v as any).label || null);
			}
			if (mounted && status === 'Loading last position…') setStatus('');
		}
		prime();
		return () => { mounted = false; };
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [code]);

	useEffect(() => {
		if (!vehicleId) return;
		const channel = supabase
			.channel(`live:${vehicleId}`)
			.on(
        'postgres_changes',
				{ event: '*', schema: 'public', table: 'vehicle_live', filter: `vehicle_id=eq.${vehicleId}` },
				(payload: any) => {
					const eventType = (payload.eventType || payload.type || '').toUpperCase();
					if (eventType === 'DELETE') {
						setPoint(null);
						setStatus('Offline');
						return;
					}
					const row = (payload.new || payload.record || payload) as any;
					if (!row || row.lat == null || row.lng == null) return;
					setPoint({
						lat: row.lat,
						lng: row.lng,
						speed: row.speed,
						heading: row.heading,
						accuracy: row.accuracy,
						status: row.status,
						ts: row.ts,
						route: row.route || null,
					});
					setStatus('');
				}
			)
			.subscribe();

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
			if (typeof point.lat === 'number' && typeof point.lng === 'number') {
				mapRef.current.setView([point.lat, point.lng], 15);
			}
		}
	}, [point]);

	const waiting = (
		<div className="absolute inset-0" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
			<span className="text-sm text-muted">Waiting for first location…</span>
		</div>
	);

	const offline = (
		<div className="absolute inset-0" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
			<span className="text-sm text-muted">Vehicle is offline</span>
		</div>
	);

	const hasCoords = !!(point && typeof point.lat === 'number' && typeof point.lng === 'number');
	const statusLabel = point?.status === 'paused' ? 'Paused' : hasCoords ? 'Online' : 'Offline';

	const infoOverlay = (
		<div className="absolute left-0 right-0 bottom-0 p-0 sm:p-4 z-[401]" aria-live="polite">
			<div className="w-full sm:max-w-xl sm:mx-auto card card-contrast px-4 py-6 sm:p-4 flex items-center justify-between gap-4 rounded-b-none sm:rounded-t-xl sm:rounded-b-xl track-info-card">
				<div className="min-w-0">
					<div className="text-sm text-muted">Vehicle</div>
					<div className="font-medium truncate">{vehicleLabel || code}</div>
				</div>
				<div className="flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-1 sm:gap-6 text-sm">
					<div>
						<span className="text-muted">Last:</span>{' '}
						{point?.ts ? new Date(point.ts).toLocaleTimeString() : '—'}
					</div>
					<div>
						<span className="text-muted">Status:</span>{' '}
						{statusLabel === 'Paused' ? (
							<span className="text-yellow-600">Paused</span>
						) : statusLabel === 'Online' ? (
							<span className="text-emerald-600">Online</span>
						) : (
							<span className="text-red-600">Offline</span>
						)}
					</div>
				</div>
			</div>
		</div>
	);

	return (
		<div className="w-full h-full relative">
			{showInput && (
				<div className="absolute left-0 right-0 top-0 p-4 flex flex-wrap items-center gap-3 z-[401]" suppressHydrationWarning>
					<input
						defaultValue={code}
						placeholder="Enter vehicle code (e.g., ONX-102)"
						className="input max-w-xs"
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								const target = (e.target as HTMLInputElement);
								const newCode = target.value.trim();
								if (newCode) window.location.href = `/track/${encodeURIComponent(newCode)}`;
							}
						}}
					/>
					<div className="text-sm text-muted">{status}</div>
				</div>
			)}
			{!hasCoords || !pulseIcon ? (
				status === 'Offline' ? offline : waiting
			) : (
				<MapContainer
					center={[point!.lat, point!.lng] as [number, number]}
					zoom={15}
					zoomControl={false}
					attributionControl={false}
					whenCreated={(m: any) => {
						mapRef.current = m;
						m.setView([point!.lat, point!.lng], 15);
					}}
					style={{ position: 'absolute', inset: 0 }}
				>
					<TileLayer
						attribution={attribution}
						url={tileUrl}
						detectRetina={!usingMapTiler}
						tileSize={usingMapTiler ? 512 : undefined as any}
						zoomOffset={usingMapTiler ? -1 : undefined as any}
					/>
					{point?.route?.coordinates && point.route.coordinates.length > 1 && (
						<Polyline
							positions={point.route.coordinates.map(c => [c.lat, c.lng] as [number, number])}
							pathOptions={{ color: '#3b82f6', weight: 4, opacity: 0.8 }}
						/>
					)}
					<Marker position={[point!.lat, point!.lng] as [number, number]} icon={pulseIcon as any}>
						<Popup>
							<div className="text-sm">
								<div>Lat: {Number(point!.lat).toFixed(5)}, Lng: {Number(point!.lng).toFixed(5)}</div>
								{point!.speed != null && <div>Speed: {Math.round(point!.speed!)} m/s</div>}
								{point!.ts && <div>Last seen: {new Date(point!.ts!).toLocaleTimeString()}</div>}
							</div>
						</Popup>
					</Marker>
				</MapContainer>
			)}
			{infoOverlay}
			<style jsx global>{`
				.leaflet-div-icon.pulse-icon { background: transparent; border: none; }
				.pulse-icon .pulse-dot { width: 18px; height: 18px; background: #14b8a6; border: 2px solid #ffffff; border-radius: 9999px; box-shadow: 0 0 0 rgba(20, 184, 166, 0.5); position: relative; }
				.pulse-icon .pulse-dot::after { content: ''; position: absolute; left: 50%; top: 50%; width: 100%; height: 100%; border-radius: 9999px; transform: translate(-50%, -50%) scale(1); background: rgba(20, 184, 166, 0.35); animation: pulse-ring 1.8s ease-out infinite; }
				@keyframes pulse-ring { 0% { transform: translate(-50%, -50%) scale(1); opacity: 0.75; } 100% { transform: translate(-50%, -50%) scale(2.8); opacity: 0; } }
				/* Hide Leaflet attribution overlay if it renders */
				.leaflet-control-attribution { display: none !important; }
				/* Remove bottom radius on small screens and in-app webviews */
				@media (max-width: 639px) {
					.track-info-card { border-bottom-left-radius: 0 !important; border-bottom-right-radius: 0 !important; }
				}
			`}</style>
		</div>
	);
}
