import { supabaseServiceClient } from '@/lib/supabaseServer';
import { addVehicle, deleteVehicle } from './actions';
import QRCode from 'qrcode';

async function getVehicles() {
  const supabase = supabaseServiceClient();
  const { data } = await supabase
    .from('vehicle_with_live')
    .select('*')
    .order('created_at', { ascending: false });
  return data || [];
}

async function qrDataUrl(code: string) {
  const baseUrl = process.env.NEXT_PUBLIC_TRACK_BASE_URL || 'https://track.example.com';
  const text = `${baseUrl}/v/${encodeURIComponent(code)}`;
  return await QRCode.toDataURL(text, { width: 256 });
}

export default async function AdminPage() {
  const vehicles = await getVehicles();

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-semibold">Vehicles</h1>

      <form action={addVehicle} className="flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-sm font-medium mb-1">Label</label>
          <input
            name="label"
            className="w-full border rounded px-3 py-2"
            placeholder="e.g., Route A Bus 1"
          />
        </div>
        <button className="bg-black text-white px-4 py-2 rounded">Add</button>
      </form>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="py-2 pr-4">Label</th>
              <th className="py-2 pr-4">Code</th>
              <th className="py-2 pr-4">Last seen</th>
              <th className="py-2 pr-4">QR</th>
              <th className="py-2 pr-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {vehicles.map(async (v: any) => {
              const dataUrl = await qrDataUrl(v.public_code);
              const last = v.live_ts ? new Date(v.live_ts as string) : null;
              return (
                <tr key={v.id} className="border-b align-top">
                  <td className="py-2 pr-4">{v.label}</td>
                  <td className="py-2 pr-4 font-mono">{v.public_code}</td>
                  <td className="py-2 pr-4">{last ? last.toLocaleString() : '—'}</td>
                  <td className="py-2 pr-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={dataUrl} alt={`QR ${v.public_code}`} className="w-24 h-24" />
                    <a
                      href={dataUrl}
                      download={`vehicle-${v.public_code}.png`}
                      className="text-blue-600 text-xs"
                    >
                      Download
                    </a>
                  </td>
                  <td className="py-2 pr-4">
                    <form action={async () => { 'use server'; await deleteVehicle(v.id); }}>
                      <button className="text-red-600">Delete</button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}


