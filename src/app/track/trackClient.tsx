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
		// Follow animated head to reduce perceived jitter
		if (!mapRef.current || !display) return;
		try {
			const z = mapRef.current.getZoom ? mapRef.current.getZoom() : 15;
			if (mapRef.current.panTo) {
				mapRef.current.panTo([display.lat, display.lng], { animate: true });
			} else if (mapRef.current.setView) {
				mapRef.current.setView([display.lat, display.lng], z, { animate: true });
			}
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

	// Animate marker position: path-parameterized rAF loop for fluid motion
	useEffect(() => {
		// If we have a route, run the path-based renderer; otherwise fall back to simple snapping
		if (!routeParam) {
			// Fallback: snap to latest point (will still be stepped by ping cadence)
			if (point && typeof point.lat === 'number' && typeof point.lng === 'number') {
				setDisplay({ lat: point.lat, lng: point.lng });
			}
			return;
		}
		let last = performance.now();
		const tau = 0.28; // response for currentS -> desiredS
		const tauTarget = 0.40; // response for desiredS -> desiredTargetS
		const extraSpeed = 4; // extra m/s available to catch up corrections
		const loop = (now: number) => {
			const dt = Math.max(0.001, Math.min(0.08, (now - last) / 1000));
			last = now;
			// Advance desired target along time with smoothed speed
			if (!isStationaryRef.current) {
				desiredTargetSRef.current += Math.max(0, desiredVRef.current) * dt;
			}
			// Ease desiredS toward desiredTargetS
			{
				const errT = desiredTargetSRef.current - desiredSRef.current;
				const alphaT = 1 - Math.exp(-dt / tauTarget);
				desiredSRef.current += errT * alphaT;
			}
			// Smoothly move current toward desired, limiting per-frame speed
			const targetS = desiredSRef.current;
			const s = currentSRef.current;
			const err = targetS - s;
			const alpha = 1 - Math.exp(-dt / tau);
			const maxV = Math.max(2, Math.min(50, desiredVRef.current + extraSpeed)); // m/s
			const maxStep = maxV * dt;
			const step = Math.max(-maxStep, Math.min(maxStep, err * alpha * 1.5));
			currentSRef.current = s + step;
			// Emit display
			let pos = routeParam.positionAtS(currentSRef.current);
			// If a teleport override is active, blend position to avoid instant jump
			if (teleportStartMsRef.current != null && teleportFromRef.current && teleportToRef.current) {
				const t = Math.max(0, Math.min(1, (performance.now() - teleportStartMsRef.current) / teleportDurMsRef.current));
				// easeInOutCubic
				const tt = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
				pos = {
					lat: teleportFromRef.current.lat + (teleportToRef.current.lat - teleportFromRef.current.lat) * tt,
					lng: teleportFromRef.current.lng + (teleportToRef.current.lng - teleportFromRef.current.lng) * tt,
				};
				if (t >= 1) {
					teleportStartMsRef.current = null;
					teleportFromRef.current = null;
					teleportToRef.current = null;
				}
			}
			setDisplay(pos);
			rafIdRef.current = requestAnimationFrame(loop);
		};
		rafIdRef.current = requestAnimationFrame(loop);
		return () => {
			if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
			rafIdRef.current = null;
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [routeParam, point?.lat, point?.lng]);

	// On route change, re-project current head to the new route to avoid jumps
	useEffect(() => {
		if (!routeParam) return;
		const head = display || (point && typeof point.lat === 'number' && typeof point.lng === 'number' ? { lat: point.lat, lng: point.lng } : null);
		if (!head) return;
		const proj = routeParam.projectPointToS(head.lat, head.lng);
		// Plan a short teleport-blend from current visual position to the nearest point on the new route
		const to = routeParam.positionAtS(proj.s);
		if (display) {
			teleportFromRef.current = display;
			teleportToRef.current = to;
			// Duration based on distance (15–1000ms per 10m, clamped 500–1400ms)
			const mPerDegLat = 111132.0;
			const mPerDegLng = 111320.0 * Math.cos((display.lat * Math.PI) / 180);
			const dx = (to.lng - display.lng) * mPerDegLng;
			const dy = (to.lat - display.lat) * mPerDegLat;
			const dist = Math.sqrt(dx * dx + dy * dy);
			teleportDurMsRef.current = Math.max(500, Math.min(1400, (dist / 10) * 150));
			teleportStartMsRef.current = performance.now();
		}
		// Align s targets to the new route; rAF will render using teleport blend
		currentSRef.current = proj.s;
		desiredSRef.current = proj.s;
		desiredTargetSRef.current = proj.s;
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [routeParam]);

	// On each live ping: project onto path, estimate speed, update targets
	useEffect(() => {
		if (!point) return;
		// Update clock skew (EMA) from server timestamp if present
		if (point.ts) {
			const serverMs = new Date(point.ts).getTime();
			const offset = serverMs - Date.now();
			clockSkewMsRef.current = clockSkewMsRef.current * 0.9 + offset * 0.1;
		}
		if (!routeParam || typeof point.lat !== 'number' || typeof point.lng !== 'number') {
			// Without a route, just snap display; rAF fallback will keep it steady
			setDisplay({ lat: point.lat as number, lng: point.lng as number });
			return;
		}
		const proj = routeParam.projectPointToS(point.lat!, point.lng!);
		const sPing = proj.s;
		const serverNow = point.ts ? new Date(point.ts).getTime() : (Date.now() + clockSkewMsRef.current);
		let vPing = typeof point.speed === 'number' ? Math.max(0, Math.min(point.speed || 0, 50)) : 0;
		if (!vPing && prevSPingRef.current != null && prevPingServerMsRef.current != null) {
			const ds = sPing - prevSPingRef.current;
			const dt = Math.max(0.2, (serverNow - prevPingServerMsRef.current) / 1000);
			vPing = Math.max(0, Math.min(50, ds / dt));
		}
		prevSPingRef.current = sPing;
		prevPingServerMsRef.current = serverNow;
		// Smooth speed with EMA to reduce jitter
		emaSpeedRef.current = emaSpeedRef.current === 0 ? vPing : (emaSpeedRef.current * 0.85 + vPing * 0.15);
		const vSmoothed = Math.max(0, Math.min(50, emaSpeedRef.current));
		const leadSec = 0.9;
		// Update stationary detector history
		{
			const nowT = serverNow;
			const hist = sHistRef.current;
			hist.push({ s: sPing, t: nowT });
			// trim to last ~10s
			while (hist.length > 0 && nowT - hist[0].t > 10000) hist.shift();
			// compute displacement over dispWindowSec
			const windowStartT = nowT - dispWindowSecRef.current * 1000;
			let minS = sPing;
			for (let i = hist.length - 1; i >= 0; i--) {
				if (hist[i].t < windowStartT) break;
				if (hist[i].s < minS) minS = hist[i].s;
			}
			const disp = Math.max(0, sPing - minS);
			const stationary = (vSmoothed < speedThreshRef.current) && (disp < dispMetersThreshRef.current);
			isStationaryRef.current = stationary;
		}
		// Apply gating
		if (isStationaryRef.current) {
			desiredVRef.current = 0;
			desiredTargetSRef.current = sPing; // no lookahead when stationary
		} else {
			desiredVRef.current = vSmoothed;
			// Ease target in the rAF loop by updating desiredTargetS only
			desiredTargetSRef.current = sPing + vSmoothed * leadSec;
		}
		// If correction is very large (e.g., GPS jump), blend visually instead of snapping
		const bigJump = Math.abs(desiredTargetSRef.current - currentSRef.current) > 120; // meters
		if (bigJump && routeParam && display) {
			const to = routeParam.positionAtS(sPing);
			teleportFromRef.current = display;
			teleportToRef.current = to;
			const mPerDegLat = 111132.0;
			const mPerDegLng = 111320.0 * Math.cos((display.lat * Math.PI) / 180);
			const dx = (to.lng - display.lng) * mPerDegLng;
			const dy = (to.lat - display.lat) * mPerDegLat;
			const dist = Math.sqrt(dx * dx + dy * dy);
			teleportDurMsRef.current = Math.max(450, Math.min(1200, (dist / 10) * 120));
			teleportStartMsRef.current = performance.now();
		}
		// First-time initialization of display
		if (!display) {
			currentSRef.current = sPing;
			desiredSRef.current = sPing;
			desiredTargetSRef.current = sPing + vSmoothed * leadSec;
			setDisplay(routeParam.positionAtS(sPing));
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [point?.lat, point?.lng, point?.ts, routeParam]);

	// Snap the animated display to the current route if within a small threshold
	const snappedDisplay = useMemo(() => {
		// If rendering along a route, avoid re-projecting per frame (prevents micro jitter)
		if (!display || !point || point.status === 'paused' || ((point.route?.coordinates?.length || 0) >= 2)) return display;
		const coords = point.route?.coordinates || [];
		if (!coords || coords.length < 2) return display;
		// Local equirectangular projection around current latitude
		const refLat = display.lat * Math.PI / 180;
		const mPerDegLat = 111132.0;
		const mPerDegLng = 111320.0 * Math.cos(refLat);
		const toXY = (p: { lat: number; lng: number }) => ({ x: p.lng * mPerDegLng, y: p.lat * mPerDegLat });
		const toLL = (x: number, y: number) => ({ lat: y / mPerDegLat, lng: x / mPerDegLng });
		const P = toXY(display);
		let best = display;
		let bestDist = Number.POSITIVE_INFINITY;
		for (let i = 0; i < coords.length - 1; i++) {
			const A = toXY(coords[i]);
			const B = toXY(coords[i + 1]);
			const vx = B.x - A.x, vy = B.y - A.y;
			const vlen2 = vx * vx + vy * vy;
			let t = vlen2 === 0 ? 0 : ((P.x - A.x) * vx + (P.y - A.y) * vy) / vlen2;
			if (t < 0) t = 0;
			if (t > 1) t = 1;
			const sx = A.x + t * vx, sy = A.y + t * vy;
			const dx = P.x - sx, dy = P.y - sy;
			const dist = Math.sqrt(dx * dx + dy * dy); // meters in projected space
			if (dist < bestDist) {
				bestDist = dist;
				const ll = toLL(sx, sy);
				best = { lat: ll.lat, lng: ll.lng };
			}
		}
		return bestDist <= 25 ? best : display; // 25m snap threshold
	}, [display?.lat, display?.lng, point?.status, point?.route?.coordinates]);

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

	// Compute a displayRoute that starts at the animated display position and trims the backend route up to the nearest point
	const displayRoute = useMemo(() => {
		if (!point || point.status === 'paused') return [] as Array<[number, number]>;
		const routeCoords = point.route?.coordinates || [];
		if (!routeCoords || routeCoords.length === 0) return [] as Array<[number, number]>;
		const head = snappedDisplay || display || (hasCoords ? { lat: point.lat, lng: point.lng } : null);
		if (!head) return [] as Array<[number, number]>;
		// Find nearest index in the route to the current head
		let nearestIdx = 0;
		let nearestScore = Number.POSITIVE_INFINITY;
		for (let i = 0; i < routeCoords.length; i++) {
			const dx = routeCoords[i].lat - head.lat;
			const dy = routeCoords[i].lng - head.lng;
			const score = dx * dx + dy * dy; // squared degrees distance; sufficient for choosing nearest index
			if (score < nearestScore) {
				nearestScore = score;
				nearestIdx = i;
			}
		}
		const trimmed: Array<[number, number]> = [];
		trimmed.push([head.lat, head.lng]);
		for (let i = nearestIdx + 1; i < routeCoords.length; i++) {
			trimmed.push([routeCoords[i].lat, routeCoords[i].lng]);
		}
		return trimmed;
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [point?.status, point?.route?.coordinates, display?.lat, display?.lng, hasCoords, point?.lat, point?.lng]);

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
