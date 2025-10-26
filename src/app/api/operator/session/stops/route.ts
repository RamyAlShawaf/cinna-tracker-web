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
    const sessionId = (searchParams.get('session_id') || '').trim();
    if (!sessionId) return NextResponse.json({ error: 'session_id required' }, { status: 400 });

    const supabase = createClient(
      getEnv('NEXT_PUBLIC_SUPABASE_URL'),
      getEnv('SUPABASE_SERVICE_ROLE_KEY')
    );

    const { data: sess, error: sErr } = await supabase
      .from('vehicle_sessions')
      .select('trip_id')
      .eq('id', sessionId)
      .is('ended_at', null)
      .single();
    if (sErr || !sess) return NextResponse.json({ error: 'Session not found/ended' }, { status: 404 });
    if (!sess.trip_id) return NextResponse.json({ stops: [] });

    const { data: stops, error } = await supabase
      .from('trip_stops')
      .select('id, name, lat, lng, sequence, dwell_seconds')
      .eq('trip_id', sess.trip_id)
      .order('sequence', { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ stops: stops || [] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 });
  }
}


