import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function isAuthenticated(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get('admin_token')?.value;
  if (!token) return false;
  try {
    const secret = new TextEncoder().encode(getEnv('ADMIN_JWT_SECRET'));
    const { payload } = await jwtVerify(token, secret);
    return payload.scope === 'admin' || payload.scope === 'owner';
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname, origin, search } = req.nextUrl;
  if (pathname.startsWith('/admin')) {
    const ok = await isAuthenticated(req);
    if (!ok) {
      const nextUrl = encodeURIComponent(pathname + (search || ''));
      return NextResponse.redirect(`${origin}/login?next=${nextUrl}`);
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*'],
};


