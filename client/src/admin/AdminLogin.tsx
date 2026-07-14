import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../api';
import type { AdminUser } from '../types';

export default function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('admin@bookit.local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ token: string; user: AdminUser }>('/api/auth/login', { email, password });
      setToken(res.token);
      localStorage.setItem('bookit_admin_user', JSON.stringify(res.user));
      navigate('/admin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form onSubmit={submit} className="login-card">
        <h1>📅 BookIt Admin</h1>
        <p className="muted">Sign in to manage providers and bookings.</p>
        <label>
          Email
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error-box">{error}</p>}
        <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="muted hint">Seeded credentials: admin@bookit.local / admin123</p>
      </form>
    </div>
  );
}
