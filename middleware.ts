import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function isAuthenticated(req: NextRequest, res: NextResponse): Promise<boolean> {
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
  const { data: { session } } = await supabase.auth.getSession();
  return !!session?.user?.id;
}

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const { pathname, origin, search } = req.nextUrl;
  if (pathname.startsWith('/admin')) {
    const ok = await isAuthenticated(req, res);
    if (!ok) {
      const nextUrl = encodeURIComponent(pathname + (search || ''));
      return NextResponse.redirect(`${origin}/login?next=${nextUrl}`);
    }
  }
  return res;
}

export const config = {
  matcher: ['/admin/:path*'],
};


