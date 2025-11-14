import { NextRequest, NextResponse } from 'next/server';

// Proxy to OSRM Nearest API to snap a point to the road network
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const lat = Number(searchParams.get('lat'));
    const lng = Number(searchParams.get('lng'));
    if (!isFinite(lat) || !isFinite(lng)) {
      return NextResponse.json({ error: 'Invalid coordinates' }, { status: 400 });
    }
    const url = `https://router.project-osrm.org/nearest/v1/driving/${lng},${lat}?number=1`;
    const r = await fetch(url);
    const j = await r.json();
    const wp = j?.waypoints?.[0];
    if (!wp || !Array.isArray(wp.location)) {
      return NextResponse.json({ lat, lng, distance: null });
    }
    // OSRM returns [lng, lat]
    const snappedLng = Number(wp.location[0]);
    const snappedLat = Number(wp.location[1]);
    const distance = Number(wp.distance ?? null);
    return NextResponse.json({ lat: snappedLat, lng: snappedLng, distance });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Bad Request' }, { status: 400 });
  }
}


