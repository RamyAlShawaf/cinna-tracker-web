import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { jwtVerify } from 'jose';

const bodySchema = z.object({
  status: z.enum(['online', 'paused']),
});

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function verifyToken(token: string) {
  const secret = new TextEncoder().encode(getEnv('PUBLISH_JWT_SECRET'));
  const { payload } = await jwtVerify(token, secret);
  if ((payload as any).scope !== 'publish') throw new Error('Invalid scope');
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
    const { status } = bodySchema.parse(json);

    const supabase = createClient(
      getEnv('NEXT_PUBLIC_SUPABASE_URL'),
      getEnv('SUPABASE_SERVICE_ROLE_KEY')
    );

    const { error } = await supabase.rpc('set_vehicle_status', {
      p_session_id: claims.session_id,
      p_status: status,
    });
    if (error) {
      // Fallback: directly update using service role (in case RPC isn't deployed yet)
      const { error: uErr } = await supabase
        .from('vehicle_live')
        .update({ status, ts: new Date().toISOString() })
        .eq('vehicle_id', claims.vehicle_id);
      if (uErr) return NextResponse.json({ error: uErr.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 });
  }
}


