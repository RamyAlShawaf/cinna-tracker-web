import { NextRequest, NextResponse } from 'next/server';
import { supabaseServiceClient } from '@/lib/supabaseServer';
import { getSession } from '@/lib/auth';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ tripId: string }> }) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { tripId } = await ctx.params;
    const supabase = supabaseServiceClient();

    if (session.scope !== 'admin') {
      const { data: trip } = await supabase
        .from('trips')
        .select('company_id')
        .eq('id', tripId)
        .maybeSingle();
      if (!trip || trip.company_id !== session.company_id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const { data, error } = await supabase
      .from('trip_stops')
      .select('id, name, lat, lng, sequence, dwell_seconds, created_at')
      .eq('trip_id', tripId)
      .order('sequence', { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ stops: data || [] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 });
  }
}


