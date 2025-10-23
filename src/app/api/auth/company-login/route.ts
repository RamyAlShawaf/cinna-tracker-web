import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { SignJWT } from 'jose';

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

    // Sign in the user via Supabase Auth
    const supabase = createClient(getEnv('NEXT_PUBLIC_SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'));
    const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
    if (signInErr || !signInData.user) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const userId = signInData.user.id;

    // Platform admin?
    const { data: adminRow } = await supabase
      .from('platform_admins')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();

    // Look up company ownership membership — expects a table company_users(user_id uuid, company_id uuid, role text)
    const { data: membership, error: mErr } = await supabase
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
    const scope = isAdmin ? 'admin' : 'owner';

    // Issue our cookie JWT containing scope and company_id
    const secret = new TextEncoder().encode(getEnv('ADMIN_JWT_SECRET'));
    const ttlHours = Number(process.env.ADMIN_JWT_TTL_HOURS || '24');
    const exp = Math.floor(Date.now() / 1000) + ttlHours * 3600;
    const tokenPayload: any = { scope, user_id: userId };
    if (!isAdmin) tokenPayload.company_id = membership!.company_id;

    const token = await new SignJWT(tokenPayload)
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(exp)
      .setIssuedAt()
      .sign(secret);

    const res = NextResponse.json(isAdmin ? { ok: true, admin: true } : { ok: true, company_id: membership!.company_id });
    const isProd = process.env.NODE_ENV === 'production';
    res.cookies.set('admin_token', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: ttlHours * 3600,
    });
    return res;
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Bad Request' }, { status: 400 });
  }
}


