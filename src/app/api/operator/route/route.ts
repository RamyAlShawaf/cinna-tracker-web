import { NextRequest, NextResponse } from 'next/server';

// Simple proxy to OSRM demo server (profile=car). For production, host your own OSRM.
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const fromLat = Number(searchParams.get('from_lat'));
    const fromLng = Number(searchParams.get('from_lng'));
    const toLat = Number(searchParams.get('to_lat'));
    const toLng = Number(searchParams.get('to_lng'));
    if (!isFinite(fromLat) || !isFinite(fromLng) || !isFinite(toLat) || !isFinite(toLng)) {
      return NextResponse.json({ error: 'Invalid coordinates' }, { status: 400 });
    }

    const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;
    const r = await fetch(url);
    const json = await r.json();
    const coords = json?.routes?.[0]?.geometry?.coordinates as any[] | undefined;
    if (!coords) return NextResponse.json({ coordinates: [] });
    // OSRM returns [lng,lat]; convert to [{lat,lng}] for convenience
    const coordinates = coords.map((c: any) => ({ lat: Number(c[1]), lng: Number(c[0]) }));
    return NextResponse.json({ coordinates });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 });
  }
}


