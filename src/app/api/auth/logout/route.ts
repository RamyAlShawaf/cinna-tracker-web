import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function POST() {
  const res = NextResponse.json({ ok: true });
  const supabase = createServerClient(
    getEnv('NEXT_PUBLIC_SUPABASE_URL'),
    getEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        get() { return undefined; },
        set(name: string, value: string, options: any) { res.cookies.set({ name, value, ...options }); },
        remove(name: string, options: any) { res.cookies.set({ name, value: '', ...options }); },
      },
    }
  );
  await supabase.auth.signOut();
  return res;
}


