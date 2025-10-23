import { NextResponse } from 'next/server';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  const isProd = process.env.NODE_ENV === 'production';
  res.cookies.set('admin_token', '', {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}


