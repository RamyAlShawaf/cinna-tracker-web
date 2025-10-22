import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { SignJWT } from 'jose';

const bodySchema = z.object({
  public_code: z.string().min(1),
});

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const { public_code } = bodySchema.parse(json);

    const supabase = createClient(
      getEnv('NEXT_PUBLIC_SUPABASE_URL'),
      getEnv('SUPABASE_SERVICE_ROLE_KEY')
    );

    // Try RPC first; if the database function has an issue, fall back to manual flow
    let sessionId: string | null = null;
    let vehicleId: string | null = null;
    try {
      const { data, error } = await supabase.rpc('start_vehicle_session', {
        p_public_code: public_code,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      sessionId = row.session_id as string;
      vehicleId = row.vehicle_id as string;
    } catch (_rpcErr) {
      // Manual implementation using service role
      const { data: vehicle, error: vErr } = await supabase
        .from('vehicles')
        .select('id')
        .eq('public_code', public_code)
        .single();
      if (vErr || !vehicle) {
        return NextResponse.json({ error: vErr?.message || 'Vehicle not found' }, { status: 404 });
      }
      vehicleId = vehicle.id as string;

      // Close any lingering active sessions (defensive)
      await supabase
        .from('vehicle_sessions')
        .update({ ended_at: new Date().toISOString() })
        .eq('vehicle_id', vehicleId)
        .is('ended_at', null);

      // Create new session
      const { data: session, error: sErr } = await supabase
        .from('vehicle_sessions')
        .insert({ vehicle_id: vehicleId, started_by: null })
        .select('id')
        .single();
      if (sErr || !session) {
        return NextResponse.json({ error: sErr?.message || 'Failed to start session' }, { status: 400 });
      }
      sessionId = session.id as string;
    }

    // Mint a short-lived publish token (JWT) scoped to this session/vehicle
    const secret = new TextEncoder().encode(getEnv('PUBLISH_JWT_SECRET'));
    const ttlHours = Number(process.env.PUBLISH_JWT_TTL_HOURS || '8');
    const exp = Math.floor(Date.now() / 1000) + ttlHours * 3600;
    const token = await new SignJWT({
      scope: 'publish',
      session_id: sessionId,
      vehicle_id: vehicleId,
      public_code,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(exp)
      .setIssuedAt()
      .sign(secret);

    return NextResponse.json({
      vehicle_id: vehicleId!,
      public_code,
      session_id: sessionId!,
      publish_token: token,
      realtime_channel: `vehicle:${public_code}`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 });
  }
}


