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
	// Raw sample buffer with fixed render delay (no prediction/map-matching)
	const samplesRef = useRef<Array<{ lat: number; lng: number; t: number }>>([]);
	const renderDelayMsRef = useRef<number>(5000);
	// Animated pose is driven by a path-parameter s (meters) along the current route
	const currentSRef = useRef<number>(0);
	const desiredSRef = useRef<number>(0);
	const desiredVRef = useRef<number>(0); // m/s target speed
	const desiredTargetSRef = useRef<number>(0); // eased target s
	const emaSpeedRef = useRef<number>(0); // EMA smoothed speed
	// Stationary gating state
	const sHistRef = useRef<Array<{ s: number; t: number }>>([]);
	const isStationaryRef = useRef<boolean>(false);
	const speedThreshRef = useRef<number>(0.8); // m/s; below this likely stationary
	const dispWindowSecRef = useRef<number>(5); // seconds window to assess displacement
	const dispMetersThreshRef = useRef<number>(6); // if moved less than this over window -> stationary
	// Teleport override animation to avoid instant jumps on route changes/large corrections
	const teleportStartMsRef = useRef<number | null>(null);
	const teleportDurMsRef = useRef<number>(800);
	const teleportFromRef = useRef<{ lat: number; lng: number } | null>(null);
	const teleportToRef = useRef<{ lat: number; lng: number } | null>(null);
	const clockSkewMsRef = useRef<number>(0); // server_time - client_time EMA
	const prevSPingRef = useRef<number | null>(null);
	const prevPingServerMsRef = useRef<number | null>(null);
	const rafIdRef = useRef<number | null>(null);
	const lastHeadingRef = useRef<number | null>(null);
	const [vehicleId, setVehicleId] = useState<string | null>(null);
	const [vehicleLabel, setVehicleLabel] = useState<string | null>(null);
	const [vehiclePhotoUrl, setVehiclePhotoUrl] = useState<string | null>(null);
	const [isPreviewOpen, setIsPreviewOpen] = useState(false);
	const [status, setStatus] = useState<string>('');
	const [leaflet, setLeaflet] = useState<any>(null);
	const [isDark, setIsDark] = useState(true);
	// Client-side route override (recalc when off-route)
	const [overrideRoute, setOverrideRoute] = useState<Array<{ lat: number; lng: number }> | null>(null);
	const [userPos, setUserPos] = useState<{ lat: number; lng: number } | null>(null);
	const mapRef = useRef<any>(null);
	const animRafRef = useRef<number | null>(null);
	const animFromRef = useRef<{ lat: number; lng: number } | null>(null);
	const animToRef = useRef<{ lat: number; lng: number } | null>(null);
	const animStartRef = useRef<number>(0);
	const animDurationMsRef = useRef<number>(900);
	const centeredOnUserRef = useRef<boolean>(false);
	const geoWatchIdRef = useRef<number | null>(null);
	// Lock backend adoption after client-side reroute to avoid oscillation
	const routeLockUntilMsRef = useRef<number>(0);
	const overrideSourceRef = useRef<'client' | 'backend' | null>(null);
	// Throttle map recentering to avoid starting a new pan animation every frame
	const lastPanAtRef = useRef<number>(0);
	// Client override route remains active until superseded by a new reroute (never auto-cleared)
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
	const nearestFetchInFlightRef = useRef<boolean>(false);
	const lastNearestAtRef = useRef<number>(0);
	const snappedRoadRef = useRef<{ lat: number; lng: number; meters: number } | null>(null);

	useEffect(() => {
		let mounted = true;
		(async () => {
			const mod = await import('leaflet');
			if (mounted) setLeaflet((mod as any).default ?? mod);
		})();
		return () => { mounted = false; };
	}, []);

	// Route parameterization: precompute cumulative distances and helpers when route changes
	const routeParam = useMemo(() => {
		const coords = point?.route?.coordinates || [];
		if (!coords || coords.length < 2) return null as null | {
			coords: Array<{ lat: number; lng: number }>;
			cum: number[];
			length: number;
			toXY: (p: { lat: number; lng: number }) => { x: number; y: number };
			toLL: (x: number, y: number) => { lat: number; lng: number };
			positionAtS: (s: number) => { lat: number; lng: number };
			projectPointToS: (lat: number, lng: number) => { s: number; lat: number; lng: number; idx: number; t: number };
		};
		// Local equirectangular projection around first point
		const refLatRad = (coords[0].lat || 0) * Math.PI / 180;
		const mPerDegLat = 111132.0;
		const mPerDegLng = 111320.0 * Math.cos(refLatRad);
		const toXY = (p: { lat: number; lng: number }) => ({ x: p.lng * mPerDegLng, y: p.lat * mPerDegLat });
		const toLL = (x: number, y: number) => ({ lat: y / mPerDegLat, lng: x / mPerDegLng });
		const xy = coords.map(toXY);
		const cum: number[] = [0];
		let total = 0;
		for (let i = 0; i < xy.length - 1; i++) {
			const dx = xy[i + 1].x - xy[i].x;
			const dy = xy[i + 1].y - xy[i].y;
			const d = Math.hypot(dx, dy);
			total += d;
			cum.push(total);
		}
		const length = total;
		const positionAtS = (s: number) => {
			if (length <= 0) return coords[0];
			let ss = Math.max(0, Math.min(length, s));
			// Find segment
			let i = 0;
			while (i < cum.length - 1 && cum[i + 1] < ss) i++;
			const segStartS = cum[i];
			const segLen = Math.max(1e-6, cum[i + 1] - segStartS);
			const t = (ss - segStartS) / segLen;
			const Ax = xy[i].x, Ay = xy[i].y;
			const Bx = xy[i + 1].x, By = xy[i + 1].y;
			const x = Ax + (Bx - Ax) * t;
			const y = Ay + (By - Ay) * t;
			return toLL(x, y);
		};
		const projectPointToS = (lat: number, lng: number) => {
			const P = toXY({ lat, lng });
			let bestIdx = 0;
			let bestT = 0;
			let bestDist = Number.POSITIVE_INFINITY;
			for (let i = 0; i < xy.length - 1; i++) {
				const Ax = xy[i].x, Ay = xy[i].y;
				const Bx = xy[i + 1].x, By = xy[i + 1].y;
				const vx = Bx - Ax, vy = By - Ay;
				const vlen2 = vx * vx + vy * vy;
				let t = vlen2 === 0 ? 0 : ((P.x - Ax) * vx + (P.y - Ay) * vy) / vlen2;
				if (t < 0) t = 0;
				if (t > 1) t = 1;
				const sx = Ax + t * vx, sy = Ay + t * vy;
				const dx = P.x - sx, dy = P.y - sy;
				const dist = Math.sqrt(dx * dx + dy * dy);
				if (dist < bestDist) {
					bestDist = dist;
					bestIdx = i;
					bestT = t;
				}
			}
			const segLen = Math.max(1e-6, cum[bestIdx + 1] - cum[bestIdx]);
			const s = cum[bestIdx] + segLen * bestT;
			const Ax = xy[bestIdx].x, Ay = xy[bestIdx].y;
			const Bx = xy[bestIdx + 1].x, By = xy[bestIdx + 1].y;
			const sx = Ax + (Bx - Ax) * bestT, sy = Ay + (By - Ay) * bestT;
			const ll = toLL(sx, sy);
			return { s, lat: ll.lat, lng: ll.lng, idx: bestIdx, t: bestT };
		};
		return { coords, cum, length, toXY, toLL, positionAtS, projectPointToS };
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [point?.route?.coordinates]);

	// Bearing helper
	const bearingDeg = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
		const toRad = (d: number) => (d * Math.PI) / 180;
		const toDeg = (r: number) => (r * 180) / Math.PI;
		const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
		const dLon = toRad(b.lng - a.lng);
		const y = Math.sin(dLon) * Math.cos(lat2);
		const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
		const br = toDeg(Math.atan2(y, x));
		return (br + 360) % 360;
	};

	// displayHeading and pulsing icons will be defined after displayRoute

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
              if (mounted) {
				setPoint(data);
				// seed buffer with last known sample
				const t = data?.ts ? new Date(data.ts).getTime() : Date.now();
				samplesRef.current.push({ lat: data.lat, lng: data.lng, t });
			  }
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
					// update clock skew
					if (row.ts) {
						const serverMs = new Date(row.ts).getTime();
						const offset = serverMs - Date.now();
						clockSkewMsRef.current = clockSkewMsRef.current * 0.9 + offset * 0.1;
					}
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
					// append to raw samples buffer
					const t = row.ts ? new Date(row.ts).getTime() : (Date.now() + clockSkewMsRef.current);
					const buf = samplesRef.current;
					if (!buf.length || t >= buf[buf.length - 1].t) {
						buf.push({ lat: row.lat, lng: row.lng, t });
					} else {
						// out-of-order: insert sorted
						let i = buf.findIndex(s => s.t > t);
						if (i === -1) buf.push({ lat: row.lat, lng: row.lng, t });
						else buf.splice(i, 0, { lat: row.lat, lng: row.lng, t });
					}
					// trim to last ~2 minutes
					const cutoff = (Date.now() + clockSkewMsRef.current) - 120000;
					while (buf.length > 0 && buf[0].t < cutoff) buf.shift();
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
		// Follow the animated head, but throttle panning to prevent constant animation restarts
		if (!mapRef.current || !display) return;
		try {
			const map = mapRef.current;
			const now = performance.now();
			const minIntervalMs = 600; // don't start a new pan more than ~1.6x per second
			if ((now - lastPanAtRef.current) < minIntervalMs) return;
			if (map.latLngToContainerPoint && map.getCenter) {
				const center = map.getCenter();
				const c = map.latLngToContainerPoint([center.lat, center.lng]);
				const t = map.latLngToContainerPoint([display.lat, display.lng]);
				const distPx = Math.hypot(t.x - c.x, t.y - c.y);
				const thresholdPx = 60; // only pan if marker moved noticeably from center
				if (distPx <= thresholdPx) return;
			}
			const z = map.getZoom ? map.getZoom() : 15;
			if (map.panTo) {
				map.panTo([display.lat, display.lng], { animate: true });
			} else if (map.setView) {
				map.setView([display.lat, display.lng], z, { animate: true });
			}
			lastPanAtRef.current = now;
		} catch {}
	}, [display?.lat, display?.lng]);

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

	// Animate marker position using fixed-lag interpolation over raw samples
	useEffect(() => {
		let last = performance.now();
		const loop = (now: number) => {
			const dt = Math.max(0.001, Math.min(0.08, (now - last) / 1000));
			last = now;
			// Interpolate position at (server time - renderDelay)
			const serverNow = Date.now() + clockSkewMsRef.current;
			const targetT = serverNow - renderDelayMsRef.current;
			const buf = samplesRef.current;
			if (buf.length === 0) {
				// nothing; keep previous
			} else if (buf.length === 1) {
				setDisplay({ lat: buf[0].lat, lng: buf[0].lng });
			} else {
				// find bracket
				let i = 1;
				while (i < buf.length && buf[i].t < targetT) i++;
				if (i === 1 && targetT < buf[0].t) {
					setDisplay({ lat: buf[0].lat, lng: buf[0].lng });
				} else if (i >= buf.length) {
					const lastS = buf[buf.length - 1];
					setDisplay({ lat: lastS.lat, lng: lastS.lng });
				} else {
					const s0 = buf[i - 1];
					const s1 = buf[i];
					const t = Math.max(0, Math.min(1, (targetT - s0.t) / Math.max(1, (s1.t - s0.t))));
					const lat = s0.lat + (s1.lat - s0.lat) * t;
					const lng = s0.lng + (s1.lng - s0.lng) * t;
					setDisplay({ lat, lng });
				}
			}
			rafIdRef.current = requestAnimationFrame(loop);
		};
		rafIdRef.current = requestAnimationFrame(loop);
		return () => {
			if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
			rafIdRef.current = null;
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// No route snapping/reprojection: we keep raw samples only

	// No per-ping target planning; samples are buffered and interpolated in rAF

	// snappedDisplay is defined after activeRouteCoords and nearest-road effect

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

	// Choose active route: client override if present, else backend-provided route
	const activeRouteCoords = useMemo(() => {
		if (overrideRoute && overrideRoute.length > 1) return overrideRoute;
		return (point?.route?.coordinates || []) as Array<{ lat: number; lng: number }>;
	}, [overrideRoute, point?.route?.coordinates]);

	// Fetch nearest road snap when no route is active (throttled)
	useEffect(() => {
		if (!display) return;
		if (activeRouteCoords && activeRouteCoords.length >= 2) return; // route snapping covers this
		const now = Date.now();
		const minIntervalMs = 2000;
		if (nearestFetchInFlightRef.current || (now - lastNearestAtRef.current) < minIntervalMs) return;
		nearestFetchInFlightRef.current = true;
		lastNearestAtRef.current = now;
		(async () => {
			try {
				const url = `/api/roads/nearest?lat=${encodeURIComponent(display.lat)}&lng=${encodeURIComponent(display.lng)}`;
				const r = await fetch(url);
				const j = await r.json();
				const lat = Number(j?.lat);
				const lng = Number(j?.lng);
				const meters = Number(j?.distance ?? j?.meters ?? 0);
				if (isFinite(lat) && isFinite(lng) && isFinite(meters)) {
					snappedRoadRef.current = { lat, lng, meters };
				}
			} catch {
				// ignore
			} finally {
				nearestFetchInFlightRef.current = false;
			}
		})();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [display?.lat, display?.lng, activeRouteCoords]);

	// Snap the animated display to route (when present) or to nearest road (OSRM) within a small threshold
	const snappedDisplay = useMemo(() => {
		if (!display) return display;
		// 1) If we have an active route, snap to its nearest segment when close enough
		const route = activeRouteCoords as Array<{ lat: number; lng: number }>;
		if (route && route.length >= 2 && point?.status !== 'paused') {
			const toRad = (d: number) => (d * Math.PI) / 180;
			const refLat = toRad(display.lat);
			const mPerDegLat = 111132.0;
			const mPerDegLng = 111320.0 * Math.cos(refLat);
			const toXY = (q: { lat: number; lng: number }) => ({ x: q.lng * mPerDegLng, y: q.lat * mPerDegLat });
			const toLL = (x: number, y: number) => ({ lat: y / mPerDegLat, lng: x / mPerDegLng });
			const P = toXY(display);
			let bestIdx = 0;
			let bestT = 0;
			let bestDist2 = Number.POSITIVE_INFINITY;
			for (let i = 0; i < route.length - 1; i++) {
				const A = toXY(route[i]);
				const B = toXY(route[i + 1]);
				const vx = B.x - A.x, vy = B.y - A.y;
				const vlen2 = Math.max(1e-9, vx * vx + vy * vy);
				let t = ((P.x - A.x) * vx + (P.y - A.y) * vy) / vlen2;
				if (t < 0) t = 0;
				if (t > 1) t = 1;
				const sx = A.x + t * vx, sy = A.y + t * vy;
				const dx = P.x - sx, dy = P.y - sy;
				const d2 = dx * dx + dy * dy;
				if (d2 < bestDist2) {
					bestDist2 = d2;
					bestIdx = i;
					bestT = t;
				}
			}
			const A = toXY(route[bestIdx]);
			const B = toXY(route[bestIdx + 1]);
			const sx = A.x + (B.x - A.x) * bestT;
			const sy = A.y + (B.y - A.y) * bestT;
			const meters = Math.sqrt((P.x - sx) * (P.x - sx) + (P.y - sy) * (P.y - sy));
			if (meters <= 25) {
				const snapped = toLL(sx, sy);
				return { lat: snapped.lat, lng: snapped.lng };
			}
		}
		// 2) Otherwise, if we have a recent nearest-road snap within threshold, use it
		if (snappedRoadRef.current && snappedRoadRef.current.meters <= 25) {
			return { lat: snappedRoadRef.current.lat, lng: snappedRoadRef.current.lng };
		}
		// 3) Default to raw display
		return display;
	}, [display?.lat, display?.lng, point?.status, activeRouteCoords]);

	// Compute a displayRoute that begins at the current head (no route snapping)
	const displayRoute = useMemo(() => {
		if (!point || point.status === 'paused') return [] as Array<[number, number]>;
		const routeCoords = activeRouteCoords;
		if (!routeCoords || routeCoords.length === 0) return [] as Array<[number, number]>;
		const head = snappedDisplay || display || (hasCoords ? { lat: point.lat, lng: point.lng } : null);
		if (!head) return [] as Array<[number, number]>;
		// Begin with head, then continue from nearest route coordinate, choosing direction that best matches heading
		let nearestIdx = 0;
		let nearestScore = Number.POSITIVE_INFINITY;
		for (let i = 0; i < routeCoords.length; i++) {
			const dx = routeCoords[i].lat - head.lat;
			const dy = routeCoords[i].lng - head.lng;
			const score = dx * dx + dy * dy;
			if (score < nearestScore) {
				nearestScore = score;
				nearestIdx = i;
			}
		}
		// Estimate current heading for direction choice
		let heading: number | null = null;
		if (typeof point?.heading === 'number' && isFinite(point.heading)) {
			const sp = (typeof point?.speed === 'number' && isFinite(point.speed!)) ? point!.speed! : null;
			if (sp == null || sp >= 0.5) heading = point.heading!;
		}
		if (heading == null) {
			const buf = samplesRef.current;
			if (buf.length >= 2) {
				const a = buf[buf.length - 2];
				const b = buf[buf.length - 1];
				const dLat = b.lat - a.lat;
				const dLng = b.lng - a.lng;
				if (Math.abs(dLat) > 1e-7 || Math.abs(dLng) > 1e-7) {
					heading = bearingDeg({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
				}
			}
		}
		if (heading == null && lastHeadingRef.current != null) {
			heading = lastHeadingRef.current;
		}
		// Choose forward/backward by minimizing angular difference to heading, with small hysteresis
		const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
		let forwardScore = Number.POSITIVE_INFINITY;
		let backwardScore = Number.POSITIVE_INFINITY;
		if (heading != null) {
			if (nearestIdx < routeCoords.length - 1) {
				forwardScore = angleDiff(heading, bearingDeg(routeCoords[nearestIdx], routeCoords[nearestIdx + 1]));
			}
			if (nearestIdx > 0) {
				backwardScore = angleDiff(heading, bearingDeg(routeCoords[nearestIdx], routeCoords[nearestIdx - 1]));
			}
		} else {
			forwardScore = 0; // default to forward if no heading
		}
		const preferBackward = backwardScore + 20 < forwardScore;
		const trimmed: Array<[number, number]> = [[head.lat, head.lng]];
		if (!preferBackward) {
			for (let i = nearestIdx + 1; i < routeCoords.length; i++) {
				trimmed.push([routeCoords[i].lat, routeCoords[i].lng]);
			}
		} else {
			for (let i = nearestIdx - 1; i >= 0; i--) {
				trimmed.push([routeCoords[i].lat, routeCoords[i].lng]);
			}
		}
		return trimmed;
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [point?.status, activeRouteCoords, display?.lat, display?.lng, snappedDisplay?.lat, snappedDisplay?.lng, hasCoords, point?.lat, point?.lng]);

	// Heading to display: prefer operator device heading (when moving), else derive from recent motion; no route-tangent fallback
	const displayHeading = useMemo(() => {
		// 1) Use device heading when available and reasonable speed
		if (typeof point?.heading === 'number' && isFinite(point.heading)) {
			const sp = (typeof point?.speed === 'number' && isFinite(point.speed!)) ? point!.speed! : null;
			if (sp == null || sp >= 0.5) {
				lastHeadingRef.current = point.heading!;
				return point.heading!;
			}
		}
		// 2) Derive from recent motion samples
		const buf = samplesRef.current;
		if (buf.length >= 2) {
			const a = buf[buf.length - 2];
			const b = buf[buf.length - 1];
			// ignore tiny jitter
			const dLat = b.lat - a.lat;
			const dLng = b.lng - a.lng;
			if (Math.abs(dLat) > 1e-7 || Math.abs(dLng) > 1e-7) {
				const hdg = bearingDeg({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
				lastHeadingRef.current = hdg;
				return hdg;
			}
		}
		// 3) Fallback to last known heading (if any)
		return lastHeadingRef.current;
	}, [point?.heading, point?.speed, display?.lat, display?.lng]);

	// Compare two routes with a small spatial tolerance (meters)
	const routesSimilar = (a?: Array<{ lat: number; lng: number }> | null, b?: Array<{ lat: number; lng: number }> | null, tolMeters: number = 15) => {
		if (!a || !b) return false;
		if (!Array.isArray(a) || !Array.isArray(b)) return false;
		if (a.length < 2 || b.length < 2) return false;
		const toRad = (d: number) => (d * Math.PI) / 180;
		const R = 6371000;
		const hav = (p1: { lat: number; lng: number }, p2: { lat: number; lng: number }) => {
			const dLat = toRad(p2.lat - p1.lat);
			const dLng = toRad(p2.lng - p1.lng);
			const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
			const h = s1 * s1 + Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * s2 * s2;
			return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
		};
		// Compare first and last few points to decide similarity quickly
		const n = Math.min(5, Math.min(a.length, b.length));
		for (let i = 0; i < n; i++) {
			if (hav(a[i], b[i]) > tolMeters) return false;
			if (hav(a[a.length - 1 - i], b[b.length - 1 - i]) > tolMeters) return false;
		}
		return true;
	};

	// If backend route changes (e.g., operator selected a new destination on Flutter), adopt it
	// Only when no client override is active (avoid flicker between old/new)
	useEffect(() => {
		const backend = (point?.route?.coordinates || []) as Array<{ lat: number; lng: number }>;
		if (!backend || backend.length < 2) return;
		const now = Date.now();
		// If no current override, adopt backend route
		if (!overrideRoute || overrideRoute.length < 2) {
			setOverrideRoute(backend);
			overrideSourceRef.current = 'backend';
			return;
		}
		// If backend is similar to current override, it's safe to align with backend without causing flicker
		if (routesSimilar(overrideRoute, backend, 15)) {
			setOverrideRoute(backend);
			overrideSourceRef.current = 'backend';
			return;
		}
		// If current override originated from client reroute and the lock is active, avoid flipping back to backend
		if (overrideSourceRef.current === 'client' && now < routeLockUntilMsRef.current) {
			return;
		}
		// Lock expired or backend route is intentionally different; adopt backend
		setOverrideRoute(backend);
		overrideSourceRef.current = 'backend';
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [point?.route?.coordinates, overrideRoute]);

	const pulseIcon = useMemo(() => {
		if (!leaflet) return null;
		const arrow = (displayHeading != null)
			? `<div class="heading-arrow" style="transform: translate(-50%,-50%) rotate(${displayHeading}deg) translate(0,-12px)"></div>`
			: '';
		return leaflet.divIcon({
			className: 'pulse-icon',
			html: `<div class="pulse-dot"></div>${arrow}`,
			iconSize: [28, 28],
			iconAnchor: [14, 14],
			popupAnchor: [0, -12],
		});
	}, [leaflet, displayHeading]);

	const pulseIconPaused = useMemo(() => {
		if (!leaflet) return null;
		const arrow = (displayHeading != null)
			? `<div class="heading-arrow" style="transform: translate(-50%,-50%) rotate(${displayHeading}deg) translate(0,-12px)"></div>`
			: '';
		return leaflet.divIcon({
			className: 'pulse-icon paused',
			html: `<div class="pulse-dot"></div>${arrow}`,
			iconSize: [28, 28],
			iconAnchor: [14, 14],
			popupAnchor: [0, -12],
		});
	}, [leaflet, displayHeading]);

	// Web client does not compute reroutes; backend/Flutter publish the authoritative route

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
					{point?.status !== 'paused' && displayRoute.length > 1 && (
						<Polyline
							positions={displayRoute}
							pathOptions={{ color: (isDark ? '#ffffff' : '#000000'), weight: 4, opacity: 0.9 }}
						/>
					)}
					{point?.status !== 'paused' && activeRouteCoords && activeRouteCoords.length > 0 && (
						<Marker
							position={[
								activeRouteCoords[activeRouteCoords.length - 1].lat,
								activeRouteCoords[activeRouteCoords.length - 1].lng,
							] as [number, number]}
							icon={(destIcon || undefined) as any}
						/>
					)}
					{hasCoords && (
						<Marker position={[(snappedDisplay?.lat ?? display?.lat ?? point!.lat), (snappedDisplay?.lng ?? display?.lng ?? point!.lng)] as [number, number]} icon={((point?.status === 'paused' ? pulseIconPaused : pulseIcon) || undefined) as any}>
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
				/* Heading arrow (rotated via inline style; translation centers and lifts above dot) */
				.pulse-icon .heading-arrow {
					position: absolute;
					left: 50%;
					top: 50%;
					width: 0;
					height: 0;
					border-left: 5px solid transparent;
					border-right: 5px solid transparent;
					border-bottom: 10px solid #14b8a6;
					filter: drop-shadow(0 0 1px rgba(0,0,0,0.25));
					pointer-events: none;
				}
				.pulse-icon.paused .heading-arrow {
					border-bottom-color: #f59e0b;
				}
				.leaflet-div-icon.user-icon { background: transparent; border: none; }
				.user-icon .user-dot { width: 14px; height: 14px; background: #3b82f6; border: 2px solid #ffffff; border-radius: 9999px; box-shadow: 0 0 0 rgba(59, 130, 246, 0.45); }
				.leaflet-div-icon.dest-icon { background: transparent; border: none; }
				.dest-icon .dest-square { width: 16px; height: 16px; background: ${isDark ? '#000000' : '#ffffff'}; border: 3px solid ${isDark ? '#ffffff' : '#000000'}; border-radius: 0; box-shadow: 0 2px 6px rgba(0,0,0,0.15); }
				@keyframes pulse-ring { 0% { transform: translate(-50%, -50%) scale(1); opacity: 0.75; } 100% { transform: translate(-50%, -50%) scale(2.8); opacity: 0; } }
				/* Hide Leaflet attribution overlay if it renders */
				.leaflet-control-attribution { display: none !important; }
				/* Smooth marker movement by animating transform updates from Leaflet */
				.leaflet-marker-icon { transition: transform 180ms linear; will-change: transform; }
				/* Remove bottom radius on small screens and in-app webviews */
				@media (max-width: 639px) {
					.track-info-card { border-bottom-left-radius: 0 !important; border-bottom-right-radius: 0 !important; }
				}
			`}</style>
		</div>
	);
}
