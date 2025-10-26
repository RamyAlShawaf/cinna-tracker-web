import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServiceClient } from '@/lib/supabaseServer';
import { getSession } from '@/lib/auth';

const bodySchema = z.object({
  name: z.string().min(1),
  code: z.string().trim().optional(),
  company_id: z.string().uuid().optional(),
  path_polyline: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const json = await req.json();
    const { name, code, company_id, path_polyline } = bodySchema.parse(json);

    let companyId: string | null = null;
    if (session.scope === 'admin') {
      companyId = company_id || null;
    } else {
      companyId = session.company_id || null;
    }
    if (!companyId) return NextResponse.json({ error: 'company_id required' }, { status: 400 });

    const supabase = supabaseServiceClient();
    const { data, error } = await supabase
      .from('trips')
      .insert({ name, code: code || null, company_id: companyId, path_polyline: path_polyline || null })
      .select('id')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ id: data?.id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: 400 });
  }
}


