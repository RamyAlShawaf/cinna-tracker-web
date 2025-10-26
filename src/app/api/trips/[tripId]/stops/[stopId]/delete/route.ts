import { NextRequest, NextResponse } from 'next/server';
import { supabaseServiceClient } from '@/lib/supabaseServer';
import { getSession } from '@/lib/auth';

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ tripId: string; stopId: string }> }) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { tripId, stopId } = await ctx.params;
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

    const { error } = await supabase
      .from('trip_stops')
      .delete()
      .eq('id', stopId)
      .eq('trip_id', tripId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 });
  }
}


