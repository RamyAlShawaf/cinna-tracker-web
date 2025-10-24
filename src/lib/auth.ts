import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { supabaseServiceClient } from './supabaseServer';

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export type SessionClaims = {
  scope: 'admin' | 'owner';
  user_id: string;
  company_id?: string;
};

export async function getSession(): Promise<SessionClaims | null> {
  const cookieStore = await cookies();

  const supabase = createServerClient(
    getEnv('NEXT_PUBLIC_SUPABASE_URL'),
    getEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set() {
          // no-op in server component context
        },
        remove() {
          // no-op in server component context
        },
      },
    }
  );

  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user?.id) return null;
  const userId = session.user.id;

  // Determine scope using service-role queries
  const adminCheck = await supabaseServiceClient()
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  const isAdmin = !!adminCheck.data;
  if (isAdmin) {
    return { scope: 'admin', user_id: userId };
  }

  const membership = await supabaseServiceClient()
    .from('company_users')
    .select('company_id, role')
    .eq('user_id', userId)
    .in('role', ['owner','admin'])
    .limit(1)
    .maybeSingle();

  if (membership.data?.company_id) {
    return { scope: 'owner', user_id: userId, company_id: membership.data.company_id as string };
  }

  return null;
}


