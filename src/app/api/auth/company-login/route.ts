import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient } from '@supabase/ssr';
import { supabaseServiceClient } from '@/lib/supabaseServer';

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const { email, password } = bodySchema.parse(json);

    // Create SSR client bound to response cookies
    const res = NextResponse.json({ ok: true });
    const supabase = createServerClient(
      getEnv('NEXT_PUBLIC_SUPABASE_URL'),
      getEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
      {
        cookies: {
          get(name: string) {
            return req.cookies.get(name)?.value;
          },
          set(name: string, value: string, options: any) {
            res.cookies.set({ name, value, ...options });
          },
          remove(name: string, options: any) {
            res.cookies.set({ name, value: '', ...options });
          },
        },
      }
    );

    const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
    if (signInErr || !signInData.user) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const userId = signInData.user.id;

    // Platform admin?
    const { data: adminRow } = await supabaseServiceClient()
      .from('platform_admins')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();

    // Look up company ownership membership — expects a table company_users(user_id uuid, company_id uuid, role text)
    const { data: membership, error: mErr } = await supabaseServiceClient()
      .from('company_users')
      .select('company_id, role')
      .eq('user_id', userId)
      .in('role', ['owner','admin'])
      .limit(1)
      .maybeSingle();

    if (!adminRow && (mErr || !membership)) {
      return NextResponse.json({ error: 'No company membership' }, { status: 403 });
    }

    const isAdmin = !!adminRow;
    return NextResponse.json(isAdmin ? { ok: true, admin: true } : { ok: true, company_id: membership!.company_id }, { headers: res.headers });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Bad Request' }, { status: 400 });
  }
}


