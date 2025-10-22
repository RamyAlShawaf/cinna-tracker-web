import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

const bodySchema = z.object({
  session_id: z.string().uuid(),
});

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const { session_id } = bodySchema.parse(json);

    const supabase = createClient(
      getEnv('NEXT_PUBLIC_SUPABASE_URL'),
      getEnv('SUPABASE_SERVICE_ROLE_KEY')
    );

    const { data, error } = await supabase.rpc('end_vehicle_session', {
      p_session_id: session_id,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true, ended: Boolean(data) });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 });
  }
}


