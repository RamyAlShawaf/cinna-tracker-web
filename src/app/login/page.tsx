'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useState } from 'react';

export default function LoginPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const next = sp.get('next') || '/admin';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/auth/company-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (r.ok) {
        router.replace(next);
      } else {
        const j = await r.json().catch(() => ({}));
        setError(j.error || 'Login failed');
      }
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm card p-6 space-y-4">
        <h1 className="text-xl font-semibold">Sign in</h1>
        {error && <div className="text-red-500 text-sm">{error}</div>}
        <div>
          <label className="block text-sm mb-1 text-muted">Email</label>
          <input
            type="email"
            className="input"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm mb-1 text-muted">Password</label>
          <input
            type="password"
            className="input"
            placeholder={'Enter your password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button
          type="submit"
          className="btn btn-primary w-full disabled:opacity-60"
          disabled={loading}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}


