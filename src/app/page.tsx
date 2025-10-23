import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-[60vh] flex items-center">
      <section className="w-full grid gap-10 md:grid-cols-2 items-center">
        <div className="space-y-6">
          <h1 className="text-4xl md:text-5xl font-semibold prose-title">
            Real‑time vehicle tracking,
            <br className="hidden sm:block" /> simple and fast.
          </h1>
          <p className="text-lg text-muted max-w-prose">
            Cinna Tracker lets operators share live locations with riders and staff. Clean. Reliable. No fuss.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/track" className="btn btn-primary">Track now</Link>
            <Link href="/admin" className="btn btn-outline">Go to admin</Link>
          </div>
        </div>
        <div className="card card-contrast p-6">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="p-4">
              <div className="text-3xl font-semibold">1s</div>
              <div className="text-sm text-muted">Update latency</div>
            </div>
            <div className="p-4">
              <div className="text-3xl font-semibold">99.9%</div>
              <div className="text-sm text-muted">Uptime</div>
            </div>
            <div className="p-4">
              <div className="text-3xl font-semibold">5min</div>
              <div className="text-sm text-muted">Setup time</div>
            </div>
          </div>
          <div className="mt-6 text-sm text-muted">
            Works on desktop and mobile. Dark mode ready.
          </div>
        </div>
      </section>
    </div>
  );
}
