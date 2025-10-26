import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServiceClient } from '@/lib/supabaseServer';
import { getSession } from '@/lib/auth';

const bodySchema = z.object({
  name: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  sequence: z.number().int().min(1),
  dwell_seconds: z.number().int().min(0).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ tripId: string }> }) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { tripId } = await ctx.params;
    const json = await req.json();
    const { name, lat, lng, sequence, dwell_seconds } = bodySchema.parse(json);

    const supabase = supabaseServiceClient();

    // Permission: admin can add to any; owner can add only to own company trips
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
      .insert({ trip_id: tripId, name, lat, lng, sequence, dwell_seconds: dwell_seconds ?? null });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 });
  }
}


