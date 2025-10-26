import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const code = (searchParams.get('code') || '').trim();
    if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 });

    const supabase = createClient(
      getEnv('NEXT_PUBLIC_SUPABASE_URL'),
      getEnv('SUPABASE_SERVICE_ROLE_KEY')
    );

    const { data: vehicle, error: vErr } = await supabase
      .from('vehicles')
      .select('id, company_id')
      .eq('public_code', code)
      .single();
    if (vErr || !vehicle) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 });

    const { data: trips, error: tErr } = await supabase
      .from('trips')
      .select('id, name, code')
      .eq('company_id', vehicle.company_id)
      .order('created_at', { ascending: false });
    if (tErr) return NextResponse.json({ error: tErr.message }, { status: 400 });

    return NextResponse.json({ trips: trips || [] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 });
  }
}


