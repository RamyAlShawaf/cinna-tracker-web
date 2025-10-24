import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json({ error: 'Deprecated' }, { status: 410 });
}


