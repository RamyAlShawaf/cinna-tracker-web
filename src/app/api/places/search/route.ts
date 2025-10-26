import { NextRequest, NextResponse } from 'next/server';

function getEnv(name: string): string | undefined {
  return process.env[name];
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get('q') || '').trim();
    const lat = searchParams.get('lat');
    const lng = searchParams.get('lng');
    if (!q) return NextResponse.json({ error: 'q required' }, { status: 400 });

    const mapsKey = getEnv('GOOGLE_MAPS_API_KEY');
    if (mapsKey) {
      // Google Places Text Search (lightweight)
      const params = new URLSearchParams({ query: q, key: mapsKey });
      if (lat && lng) params.set('location', `${lat},${lng}`);
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?${params.toString()}`;
      const r = await fetch(url);
      const json = await r.json();
      const results = (json.results || []).slice(0, 10).map((p: any) => ({
        id: p.place_id,
        name: p.name,
        address: p.formatted_address,
        lat: p.geometry?.location?.lat,
        lng: p.geometry?.location?.lng,
      }));
      return NextResponse.json({ provider: 'google', results });
    }

    // Fallback to OpenStreetMap Nominatim
    const params = new URLSearchParams({ q, format: 'jsonv2', limit: '10', addressdetails: '1' });
    if (lat && lng) params.set('viewbox', `${Number(lng) - 0.2},${Number(lat) + 0.2},${Number(lng) + 0.2},${Number(lat) - 0.2}`);
    const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'CinnaTracker/1.0 (+contact)' } });
    const json = await r.json();
    const results = (json || []).map((p: any) => ({
      id: String(p.place_id),
      name: p.display_name,
      address: p.display_name,
      lat: Number(p.lat),
      lng: Number(p.lon),
    }));
    return NextResponse.json({ provider: 'osm', results });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 });
  }
}


