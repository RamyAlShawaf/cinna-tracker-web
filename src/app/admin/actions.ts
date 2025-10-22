"use server";

import { supabaseServiceClient } from '@/lib/supabaseServer';
import { generatePublicCode } from '@/lib/code';

export async function addVehicle(formData: FormData) {
  const label = String(formData.get('label') || '').trim();
  if (!label) return { error: 'Label required' };
  const code = generatePublicCode();

  const companyId = process.env.DEFAULT_COMPANY_ID || null;
  if (!companyId) return { error: 'DEFAULT_COMPANY_ID not set' };

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
  const supabase = supabaseServiceClient();
  const { error } = await supabase.from('vehicles').delete().eq('id', id);
  if (error) return { error: error.message };
  return { ok: true };
}


