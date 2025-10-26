import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await ctx.params;
    const supabase = createClient(
      getEnv('NEXT_PUBLIC_SUPABASE_URL'),
      getEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')
    );

    const { data: vehicle, error: vErr } = await supabase
      .from('vehicles')
      .select('id, public_code')
      .eq('public_code', code)
      .single();
    if (vErr || !vehicle) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { data: live, error: lErr } = await supabase
      .from('vehicle_live')
      .select('lat, lng, speed, heading, accuracy, status, ts, route')
      .eq('vehicle_id', vehicle.id)
      .single();

    if (lErr) {
      return NextResponse.json({ error: lErr.message }, { status: 404 });
    }

    return NextResponse.json({ code: vehicle.public_code, ...live });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 });
  }
}


