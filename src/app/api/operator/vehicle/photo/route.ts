import { NextRequest, NextResponse } from 'next/server';
import { supabaseServiceClient } from '@/lib/supabaseServer';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const publicCode = String(form.get('public_code') || '').trim();
    const image = form.get('image');
    if (!publicCode) return NextResponse.json({ error: 'public_code required' }, { status: 400 });
    if (!(image instanceof File)) return NextResponse.json({ error: 'image file required' }, { status: 400 });

    const supabase = supabaseServiceClient();

    const { data: vehicle, error: vErr } = await supabase
      .from('vehicles')
      .select('id')
      .eq('public_code', publicCode)
      .single();
    if (vErr || !vehicle) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 });

    const bucket = 'vehicle-photos';
    // Best-effort ensure bucket exists
    try {
      const { data: buckets } = await supabase.storage.listBuckets();
      const exists = (buckets || []).some((b) => b.name === bucket);
      if (!exists) {
        await supabase.storage.createBucket(bucket, { public: true });
      }
    } catch {}

    const arrayBuf = await image.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const path = `${vehicle.id}/${Date.now()}.jpg`;
    const contentType = image.type || 'image/jpeg';

    const { error: upErr } = await supabase.storage
      .from(bucket)
      .upload(path, buffer, { contentType, upsert: true });
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 400 });

    const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
    const photoUrl = pub.publicUrl;

    const { error: uErr } = await supabase
      .from('vehicles')
      .update({ photo_url: photoUrl })
      .eq('id', vehicle.id);
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 400 });

    return NextResponse.json({ photo_url: photoUrl });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Bad Request' }, { status: 400 });
  }
}


