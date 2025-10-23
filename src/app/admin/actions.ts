"use server";

import { supabaseServiceClient } from '@/lib/supabaseServer';
import { getSession } from '@/lib/auth';
import { generatePublicCode } from '@/lib/code';

export async function addVehicle(formData: FormData) {
  const session = await getSession();
  if (!session) return { error: 'Unauthorized' };
  const label = String(formData.get('label') || '').trim();
  if (!label) return { error: 'Label required' };
  const code = generatePublicCode();

  let companyId: string | null = null;
  if (session.scope === 'admin') {
    companyId = String(formData.get('company_id') || '').trim() || null;
  } else {
    companyId = session.company_id || null;
  }
  if (!companyId) return { error: 'company_id required' };

  const supabase = supabaseServiceClient();
  const { error } = await supabase.from('vehicles').insert({
    label,
    public_code: code,
    company_id: companyId,
  });
  if (error) return { error: error.message };
  return { ok: true };
}

export async function deleteVehicle(id: string) {
  const session = await getSession();
  if (!session) return { error: 'Unauthorized' };
  const supabase = supabaseServiceClient();
  if (session.scope === 'admin') {
    const { error } = await supabase.from('vehicles').delete().eq('id', id);
    if (error) return { error: error.message };
    return { ok: true };
  }
  const { data: v } = await supabase.from('vehicles').select('company_id').eq('id', id).maybeSingle();
  if (!v || v.company_id !== session.company_id) return { error: 'Forbidden' };
  const { error } = await supabase.from('vehicles').delete().eq('id', id);
  if (error) return { error: error.message };
  return { ok: true };
}

export async function addCompany(formData: FormData) {
  const session = await getSession();
  if (!session || session.scope !== 'admin') return { error: 'Unauthorized' };
  const name = String(formData.get('name') || '').trim();
  const slug = String(formData.get('slug') || '').trim() || null;
  const website = String(formData.get('website') || '').trim() || null;
  if (!name) return { error: 'Name required' };
  const supabase = supabaseServiceClient();
  const { error } = await supabase.from('companies').insert({ name, slug, website });
  if (error) return { error: error.message };
  return { ok: true };
}

export async function deleteCompany(id: string) {
  const session = await getSession();
  if (!session || session.scope !== 'admin') return { error: 'Unauthorized' };
  const supabase = supabaseServiceClient();
  const { error } = await supabase.from('companies').delete().eq('id', id);
  if (error) return { error: error.message };
  return { ok: true };
}

export async function addOwnerByEmail(formData: FormData) {
  const session = await getSession();
  if (!session || session.scope !== 'admin') return { error: 'Unauthorized' };
  const companyId = String(formData.get('company_id') || '').trim();
  const email = String(formData.get('email') || '').trim();
  const password = String(formData.get('password') || '').trim();
  if (!companyId) return { error: 'company_id required' };
  if (!email) return { error: 'email required' };
  if (!password) return { error: 'password required' };
  const supabase = supabaseServiceClient();

  const { data, error: createErr } = await (supabase as any).auth.admin.createUser({ email, password, email_confirm: true });
  if (createErr) return { error: createErr.message };
  const userId = data?.user?.id as string | undefined;
  if (!userId) return { error: 'Failed to create user' };

  const { error } = await supabase.from('company_users').upsert({ user_id: userId, company_id: companyId, role: 'owner' });
  if (error) return { error: error.message };
  return { ok: true };
}

export async function deleteOwner(formData: FormData) {
  const session = await getSession();
  if (!session || session.scope !== 'admin') return { error: 'Unauthorized' };
  const companyId = String(formData.get('company_id') || '').trim();
  const userId = String(formData.get('user_id') || '').trim();
  if (!companyId || !userId) return { error: 'company_id and user_id required' };
  const supabase = supabaseServiceClient();
  const { error } = await supabase.from('company_users').delete().eq('company_id', companyId).eq('user_id', userId);
  if (error) return { error: error.message };
  return { ok: true };
}


