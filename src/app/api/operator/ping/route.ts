import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { jwtVerify } from 'jose';

const bodySchema = z.object({
  lat: z.number(),
  lng: z.number(),
  speed: z.number().optional(),
  heading: z.number().optional(),
  accuracy: z.number().optional(),
  ts: z.string().optional(),
  route: z.any().optional(),
});

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function verifyToken(token: string) {
  const secret = new TextEncoder().encode(getEnv('PUBLISH_JWT_SECRET'));
  const { payload } = await jwtVerify(token, secret);
  if (payload.scope !== 'publish') throw new Error('Invalid scope');
  return payload as unknown as {
    session_id: string;
    vehicle_id: string;
    public_code: string;
    exp: number;
  };
}

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const token = searchParams.get('token');
    if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 401 });
    const claims = await verifyToken(token);

    const json = await req.json();
    const { lat, lng, speed, heading, accuracy, route } = bodySchema.parse(json);

    const supabase = createClient(
      getEnv('NEXT_PUBLIC_SUPABASE_URL'),
      getEnv('SUPABASE_SERVICE_ROLE_KEY')
    );

    const args: any = {
      p_session_id: claims.session_id,
      p_lat: lat,
      p_lng: lng,
      p_speed: speed ?? null,
      p_heading: heading ?? null,
      p_accuracy: accuracy ?? null,
    };
    if (route !== undefined && route !== null) args.p_route = route;
    let { error } = await supabase.rpc('publish_vehicle_live', args);

    // Backward-compat: if the DB hasn't been migrated to accept p_route yet,
    // retry without the parameter (older function signature)
    if (error && /p_route|function publish_vehicle_live|No function matches/i.test(error.message || '')) {
      const retry = await supabase.rpc('publish_vehicle_live', {
        p_session_id: claims.session_id,
        p_lat: lat,
        p_lng: lng,
        p_speed: speed ?? null,
        p_heading: heading ?? null,
        p_accuracy: accuracy ?? null,
      } as any);
      error = retry.error as any;
    }

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 });
  }
}


