import { supabaseServiceClient } from '@/lib/supabaseServer';
import { addVehicle, deleteVehicle, addCompany, deleteCompany, addOwnerByEmail, deleteOwner } from './actions';
import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import QRCode from 'qrcode';

async function getVehicles(companyId?: string) {
  const supabase = supabaseServiceClient();
  let q = supabase
    .from('vehicle_with_live')
    .select('*')
    .order('created_at', { ascending: false });
  if (companyId) {
    q = q.eq('company_id', companyId);
  }
  const { data } = await q;
  return data || [];
}

async function qrDataUrl(code: string) {
  const baseUrl = process.env.NEXT_PUBLIC_TRACK_BASE_URL || 'https://track.example.com';
  const text = `${baseUrl}/v/${encodeURIComponent(code)}`;
  return await QRCode.toDataURL(text, { width: 256 });
}

async function getCompanies() {
  const supabase = supabaseServiceClient();
  const { data } = await supabase.from('companies').select('id, name, slug').order('created_at', { ascending: false });
  return data || [];
}

async function getOwnersForCompany(companyId: string) {
  const supabase = supabaseServiceClient();
  const { data: memberships } = await supabase
    .from('company_users')
    .select('user_id, role')
    .eq('company_id', companyId)
    .in('role', ['owner','admin']);
  const list = memberships || [];
  const owners: Array<{ user_id: string; role: string; email: string | null }> = [];
  for (const m of list) {
    try {
      const { data } = await (supabase as any).auth.admin.getUserById(String(m.user_id));
      const email = data?.user?.email || null;
      owners.push({ user_id: m.user_id as string, role: m.role as string, email });
    } catch {
      owners.push({ user_id: m.user_id as string, role: m.role as string, email: null });
    }
  }
  return owners;
}

export default async function AdminPage() {
  const session = await getSession();
  if (!session) redirect('/login?next=/admin');
  const isAdmin = session?.scope === 'admin';
  const companies = isAdmin ? await getCompanies() : [];
  const vehicles = await getVehicles(isAdmin ? undefined : session?.company_id);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold prose-title">Admin</h1>
      </div>

      {isAdmin && (
        <section className="card p-5 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Companies</h2>
          </div>
          <form action={async (formData: FormData) => { 'use server'; await addCompany(formData); }} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm mb-1 text-muted">Name</label>
              <input name="name" className="input" placeholder="Acme Transit" />
            </div>
            <div>
              <label className="block text-sm mb-1 text-muted">Slug</label>
              <input name="slug" className="input" placeholder="acme" />
            </div>
            <div className="sm:col-span-2 lg:col-span-1">
              <label className="block text-sm mb-1 text-muted">Website</label>
              <input name="website" className="input" placeholder="https://acme.com" />
            </div>
            <div className="flex items-end">
              <button className="btn btn-primary w-full sm:w-auto">Create company</button>
            </div>
          </form>

          <div className="overflow-x-auto">
            <table className="table text-sm">
              <thead>
                <tr className="text-left">
                  <th>Name</th>
                  <th>Slug</th>
                  <th>Owners</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {await Promise.all(companies.map(async (c: any) => {
                  const owners = await getOwnersForCompany(c.id);
                  return (
                    <tr key={c.id} className="align-top">
                      <td>
                        <div className="font-medium">{c.name}</div>
                      </td>
                      <td>{c.slug || '—'}</td>
                      <td>
                        <div className="text-xs">
                          {owners.length === 0 ? (
                            <div className="italic text-muted">No owners yet</div>
                          ) : (
                            <ul className="space-y-1">
                              {owners.map(o => (
                                <li key={o.user_id} className="flex items-center gap-2">
                                  <span>{o.email || o.user_id}</span>
                                  <form action={async (formData: FormData) => { 'use server'; formData.set('company_id', c.id); formData.set('user_id', o.user_id); await deleteOwner(formData); }}>
                                    <button className="text-red-500 hover:opacity-80">Remove</button>
                                  </form>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </td>
                      <td>
                        <form action={async () => { 'use server'; await deleteCompany(c.id); }}>
                          <button className="text-red-500 hover:opacity-80">Delete</button>
                        </form>
                      </td>
                    </tr>
                  );
                }))}
              </tbody>
            </table>
          </div>

          <div className="pt-2">
            <h3 className="font-semibold mb-3">Add company owner</h3>
            <form action={async (formData: FormData) => { 'use server'; await addOwnerByEmail(formData); }} className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
              <div>
                <label className="block text-sm mb-1 text-muted">Company</label>
                <select name="company_id" className="input">
                  {companies.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm mb-1 text-muted">Owner email</label>
                <input name="email" type="email" className="input" placeholder="owner@company.com" />
              </div>
              <div>
                <label className="block text-sm mb-1 text-muted">Initial password</label>
                <input name="password" type="text" className="input" placeholder="required" required />
              </div>
              <div className="sm:col-span-3">
                <button className="btn btn-primary">Add owner</button>
              </div>
            </form>
          </div>
        </section>
      )}

      <section className="card p-5 space-y-4">
        <h2 className="text-lg font-semibold">Vehicles</h2>
        <form action={async (formData: FormData) => { 'use server'; await addVehicle(formData); }} className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
          {isAdmin && (
            <div>
              <label className="block text-sm mb-1 text-muted">Company</label>
              <select name="company_id" className="input">
                {companies.map((c: any) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="sm:col-span-2">
            <label className="block text-sm mb-1 text-muted">Label</label>
            <input
              name="label"
              className="input"
              placeholder="e.g., Route A Bus 1"
            />
          </div>
          <div>
            <button className="btn btn-primary w-full sm:w-auto">Add</button>
          </div>
        </form>

        <div className="overflow-x-auto">
          <table className="table text-sm">
            <thead>
              <tr className="text-left">
                <th>Label</th>
                <th>Code</th>
                <th>Status</th>
                <th>Last seen</th>
                <th>QR</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map(async (v: any) => {
                const dataUrl = await qrDataUrl(v.public_code);
                const last = v.live_ts ? new Date(v.live_ts as string) : null;
                const status = v.status === 'paused' ? 'Paused' : 'Online';
                const trackHref = `/track?v=${encodeURIComponent(v.public_code as string)}`;
                return (
                  <tr key={v.id} className="align-top">
                    <td className="font-medium">{v.label}</td>
                    <td className="font-mono">{v.public_code}</td>
                    <td>
                      <span className={status === 'Online' ? 'text-emerald-500' : status === 'Paused' ? 'text-yellow-600' : 'text-muted'}>{status}</span>
                    </td>
                    <td>{last ? last.toLocaleString() : '—'}</td>
                    <td>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={dataUrl} alt={`QR ${v.public_code}`} className="w-24 h-24 rounded border border-[var(--border)]" />
                      <a
                        href={dataUrl}
                        download={`vehicle-${v.public_code}.png`}
                        className="text-xs underline block mt-1"
                      >
                        Download
                      </a>
                    </td>
                    <td>
                      {status === 'Online' && (
                        <a href={trackHref} className="btn btn-outline h-8 px-3 mr-2">Track</a>
                      )}
                      <form action={async () => { 'use server'; await deleteVehicle(v.id); }}>
                        <button className="text-red-500 hover:opacity-80">Delete</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}


