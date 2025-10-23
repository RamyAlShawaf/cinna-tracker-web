import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { SignJWT } from 'jose';

const bodySchema = z.object({
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
    const { password } = bodySchema.parse(json);
    const expected = getEnv('ADMIN_PASSWORD');
    if (password !== expected) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const secret = new TextEncoder().encode(getEnv('ADMIN_JWT_SECRET'));
    const ttlHours = Number(process.env.ADMIN_JWT_TTL_HOURS || '24');
    const exp = Math.floor(Date.now() / 1000) + ttlHours * 3600;
    const token = await new SignJWT({ scope: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(exp)
      .setIssuedAt()
      .sign(secret);

    const res = NextResponse.json({ ok: true });
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


