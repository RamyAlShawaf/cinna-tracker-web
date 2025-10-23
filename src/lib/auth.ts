import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export type SessionClaims = {
  scope: 'admin' | 'owner';
  user_id: string;
  company_id?: string;
  exp: number;
  iat: number;
};

export async function getSession(): Promise<SessionClaims | null> {
  const store = await cookies();
  const token = store.get('admin_token')?.value;
  if (!token) return null;
  try {
    const secret = new TextEncoder().encode(getEnv('ADMIN_JWT_SECRET'));
    const { payload } = await jwtVerify(token, secret);
    const claims = payload as unknown as SessionClaims;
    if (claims.scope !== 'admin' && claims.scope !== 'owner') return null;
    return claims;
  } catch {
    return null;
  }
}


