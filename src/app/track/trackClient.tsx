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
	// Interpolated display position for smooth marker animation
	const [display, setDisplay] = useState<{ lat: number; lng: number } | null>(null);
	const [vehicleId, setVehicleId] = useState<string | null>(null);
	const [vehicleLabel, setVehicleLabel] = useState<string | null>(null);
	const [vehiclePhotoUrl, setVehiclePhotoUrl] = useState<string | null>(null);
	const [isPreviewOpen, setIsPreviewOpen] = useState(false);
	const [status, setStatus] = useState<string>('');
	const [leaflet, setLeaflet] = useState<any>(null);
	const [isDark, setIsDark] = useState(true);
	const [userPos, setUserPos] = useState<{ lat: number; lng: number } | null>(null);
	const mapRef = useRef<any>(null);
	const animRafRef = useRef<number | null>(null);
	const animFromRef = useRef<{ lat: number; lng: number } | null>(null);
	const animToRef = useRef<{ lat: number; lng: number } | null>(null);
	const animStartRef = useRef<number>(0);
	const animDurationMsRef = useRef<number>(900);
	const centeredOnUserRef = useRef<boolean>(false);
	const geoWatchIdRef = useRef<number | null>(null);
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

	const pulseIconPaused = useMemo(() => {
		if (!leaflet) return null;
		return leaflet.divIcon({
			className: 'pulse-icon paused',
			html: '<div class="pulse-dot"></div>',
			iconSize: [28, 28],
			iconAnchor: [14, 14],
			popupAnchor: [0, -12],
		});
	}, [leaflet]);

	const userIcon = useMemo(() => {
		if (!leaflet) return null;
		return leaflet.divIcon({
			className: 'user-icon',
			html: '<div class="user-dot"></div>',
			iconSize: [22, 22],
			iconAnchor: [11, 11],
			popupAnchor: [0, -10],
		});
	}, [leaflet]);

	const destIcon = useMemo(() => {
		if (!leaflet) return null;
		return leaflet.divIcon({
			className: 'dest-icon',
			html: '<div class="dest-square"></div>',
			iconSize: [16, 16],
			iconAnchor: [8, 8],
			popupAnchor: [0, -10],
		});
	}, [leaflet]);

	// Acquire user location (initial + watch) and center map to user once on load
	useEffect(() => {
		if (typeof window === 'undefined' || !('geolocation' in navigator)) return;
		const opts: PositionOptions = { enableHighAccuracy: true, timeout: 8000, maximumAge: 10_000 };
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
			},
			() => {
				// swallow; fallback remains vehicle position
			},
			opts
		);
		geoWatchIdRef.current = navigator.geolocation.watchPosition(
			(pos) => setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
			() => {},
			opts
		);
		return () => {
			if (geoWatchIdRef.current != null) navigator.geolocation.clearWatch(geoWatchIdRef.current);
		};
	}, []);

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
				.select('id,label,photo_url')
				.eq('public_code', code)
				.single();
				if (v?.id && mounted) {
				setVehicleId(v.id);
				setVehicleLabel((v as any).label || null);
				setVehiclePhotoUrl((v as any).photo_url || null);
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
		// Smoothly move the map center when a new target point arrives
		if (!mapRef.current || !point) return;
		if (typeof point.lat !== 'number' || typeof point.lng !== 'number') return;
		try {
			const z = mapRef.current.getZoom ? mapRef.current.getZoom() : 15;
			if (mapRef.current.flyTo) {
				mapRef.current.flyTo([point.lat, point.lng], z, { duration: 0.9 });
			} else if (mapRef.current.panTo) {
				mapRef.current.panTo([point.lat, point.lng], { animate: true });
			}
		} catch {}
	}, [point]);

	// Center to user's location once on load if permission granted
	useEffect(() => {
		if (!mapRef.current || !userPos || centeredOnUserRef.current) return;
		try {
			const z = mapRef.current.getZoom ? mapRef.current.getZoom() : 15;
			if (mapRef.current.flyTo) mapRef.current.flyTo([userPos.lat, userPos.lng], z, { duration: 0.6 });
			else if (mapRef.current.panTo) mapRef.current.panTo([userPos.lat, userPos.lng], { animate: true });
			centeredOnUserRef.current = true;
		} catch {}
	}, [userPos]);

	// Animate marker position between pings
	useEffect(() => {
		if (!point || typeof point.lat !== 'number' || typeof point.lng !== 'number') return;
		const target = { lat: point.lat, lng: point.lng };
		// First point: snap and prime state
		if (!display) {
			setDisplay(target);
			return;
		}
		// Start a new animation from current displayed position to target
		animFromRef.current = display;
		animToRef.current = target;
		animStartRef.current = performance.now();
		const duration = animDurationMsRef.current;
		const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
		if (animRafRef.current) cancelAnimationFrame(animRafRef.current);
		const tick = () => {
			const now = performance.now();
			let t = (now - animStartRef.current) / duration;
			if (t >= 1) {
				setDisplay(animToRef.current!);
				animRafRef.current = null;
				return;
			}
			t = Math.max(0, Math.min(1, t));
			t = easeInOutCubic(t);
			const from = animFromRef.current!;
			const to = animToRef.current!;
			setDisplay({
				lat: from.lat + (to.lat - from.lat) * t,
				lng: from.lng + (to.lng - from.lng) * t,
			});
			animRafRef.current = requestAnimationFrame(tick);
		};
		animRafRef.current = requestAnimationFrame(tick);
		return () => {
			if (animRafRef.current) cancelAnimationFrame(animRafRef.current);
			animRafRef.current = null;
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [point?.lat, point?.lng]);

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
				<div className="min-w-0 flex items-center gap-3">
					{vehiclePhotoUrl && (
						/* eslint-disable @next/next/no-img-element */
						<img
							src={vehiclePhotoUrl}
							alt="Vehicle"
							className="w-10 h-10 rounded object-cover border border-[var(--border)] cursor-pointer"
							onClick={() => setIsPreviewOpen(true)}
						/>
					)}
					<div>
						<div className="text-sm text-muted">Vehicle</div>
						<div className="font-medium truncate">{vehicleLabel || code}</div>
					</div>
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
			{(() => {
				const center = userPos || (hasCoords ? { lat: point!.lat, lng: point!.lng } : null);
				if (!center) return (status === 'Offline' ? offline : waiting);
				return (
					<MapContainer
						center={[center.lat, center.lng] as [number, number]}
						zoom={15}
						zoomControl={false}
						attributionControl={false}
						whenCreated={(m: any) => {
							mapRef.current = m;
							m.setView([center.lat, center.lng], 15);
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
					{userPos && (
						<Marker position={[userPos.lat, userPos.lng] as [number, number]} icon={(userIcon || undefined) as any}>
							<Popup>
								<div className="text-sm">You are here</div>
							</Popup>
						</Marker>
					)}
					{point?.status !== 'paused' && point?.route?.coordinates && point.route.coordinates.length > 1 && (
						<Polyline
							positions={point.route.coordinates.map(c => [c.lat, c.lng] as [number, number])}
							pathOptions={{ color: (isDark ? '#ffffff' : '#000000'), weight: 4, opacity: 0.9 }}
						/>
					)}
					{point?.status !== 'paused' && point?.route?.coordinates && point.route.coordinates.length > 0 && (
						<Marker
							position={[
								point.route.coordinates[point.route.coordinates.length - 1].lat,
								point.route.coordinates[point.route.coordinates.length - 1].lng,
							] as [number, number]}
							icon={(destIcon || undefined) as any}
						/>
					)}
					{hasCoords && (
						<Marker position={[(display?.lat ?? point!.lat), (display?.lng ?? point!.lng)] as [number, number]} icon={((point?.status === 'paused' ? pulseIconPaused : pulseIcon) || undefined) as any}>
						<Popup>
							<div className="text-sm">
								<div>Lat: {Number(point!.lat).toFixed(5)}, Lng: {Number(point!.lng).toFixed(5)}</div>
								{point!.speed != null && <div>Speed: {Math.round(point!.speed!)} m/s</div>}
								{point!.ts && <div>Last seen: {new Date(point!.ts!).toLocaleTimeString()}</div>}
							</div>
						</Popup>
						</Marker>
					)}
					</MapContainer>
				);
			})()}
			{infoOverlay}
			{vehiclePhotoUrl && isPreviewOpen && (
				<div
					className="fixed inset-0 z-[1000] bg-black/75 flex items-center justify-center p-4 pt-14 md:pt-20"
					role="dialog"
					aria-modal="true"
					onClick={() => setIsPreviewOpen(false)}
				>
					<div className="relative" onClick={(e) => e.stopPropagation()}>
						{/* eslint-disable @next/next/no-img-element */}
						<img
							src={vehiclePhotoUrl}
							alt="Vehicle full"
							className="max-w-[88vw] max-h-[78vh] rounded shadow-xl"
						/>
						<button
							onClick={() => setIsPreviewOpen(false)}
							className="absolute -top-3 -right-3 bg-white text-black rounded-full w-8 h-8 flex items-center justify-center shadow"
							aria-label="Close preview"
						>
							×
						</button>
					</div>
				</div>
			)}
			<style jsx global>{`
				.leaflet-div-icon.pulse-icon { background: transparent; border: none; }
				.pulse-icon .pulse-dot { width: 18px; height: 18px; background: #14b8a6; border: 2px solid #ffffff; border-radius: 9999px; box-shadow: 0 0 0 rgba(20, 184, 166, 0.5); position: relative; }
				.pulse-icon .pulse-dot::after { content: ''; position: absolute; left: 50%; top: 50%; width: 100%; height: 100%; border-radius: 9999px; transform: translate(-50%, -50%) scale(1); background: rgba(20, 184, 166, 0.35); animation: pulse-ring 1.8s ease-out infinite; }
				.pulse-icon.paused .pulse-dot { background: #f59e0b; box-shadow: 0 0 0 rgba(245, 158, 11, 0.5); }
				.pulse-icon.paused .pulse-dot::after { background: rgba(245, 158, 11, 0.35); }
				.leaflet-div-icon.user-icon { background: transparent; border: none; }
				.user-icon .user-dot { width: 14px; height: 14px; background: #3b82f6; border: 2px solid #ffffff; border-radius: 9999px; box-shadow: 0 0 0 rgba(59, 130, 246, 0.45); }
				.leaflet-div-icon.dest-icon { background: transparent; border: none; }
				.dest-icon .dest-square { width: 16px; height: 16px; background: ${isDark ? '#000000' : '#ffffff'}; border: 3px solid ${isDark ? '#ffffff' : '#000000'}; border-radius: 0; box-shadow: 0 2px 6px rgba(0,0,0,0.15); }
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
