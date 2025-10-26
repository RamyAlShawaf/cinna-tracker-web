import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServiceClient } from '@/lib/supabaseServer';
import { getSession } from '@/lib/auth';

const bodySchema = z.object({
  name: z.string().min(1).optional(),
  dwell_seconds: z.number().int().min(0).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ tripId: string; stopId: string }> }) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { tripId, stopId } = await ctx.params;
    const json = await req.json();
    const payload = bodySchema.parse(json);
    if (Object.keys(payload).length === 0) return NextResponse.json({ error: 'No fields to update' }, { status: 400 });

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

    const update: Record<string, any> = {};
    if (payload.name !== undefined) update.name = payload.name;
    if (payload.dwell_seconds !== undefined) update.dwell_seconds = payload.dwell_seconds;
    if (payload.lat !== undefined) update.lat = payload.lat;
    if (payload.lng !== undefined) update.lng = payload.lng;

    const { error } = await supabase
      .from('trip_stops')
      .update(update)
      .eq('id', stopId)
      .eq('trip_id', tripId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 });
  }
}


