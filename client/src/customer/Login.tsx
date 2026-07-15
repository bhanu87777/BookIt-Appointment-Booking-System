import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { setSession, type CustomerUser } from './auth';

type Mode = 'signin' | 'signup';

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<Mode>((params.get('mode') as Mode) || 'signin');
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res =
        mode === 'signin'
          ? await api.post<{ token: string; user: CustomerUser }>('/api/customer/auth/login', {
              email: form.email,
              password: form.password,
            })
          : await api.post<{ token: string; user: CustomerUser }>('/api/customer/auth/signup', {
              name: form.name,
              email: form.email,
              password: form.password,
              phone: form.phone || undefined,
            });
      setSession(res.token, res.user);
      navigate(params.get('next') ?? '/account');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container narrow-page">
      <div className="step-card auth-card">
        <h1>{mode === 'signin' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="muted">
          {mode === 'signin'
            ? 'Sign in to see your bookings, points and favorites.'
            : 'Past bookings made with this email are linked automatically.'}
        </p>
        <div className="tabs">
          <button className={`tab ${mode === 'signin' ? 'active' : ''}`} onClick={() => setMode('signin')}>
            Sign in
          </button>
          <button className={`tab ${mode === 'signup' ? 'active' : ''}`} onClick={() => setMode('signup')}>
            Create account
          </button>
        </div>
        <form onSubmit={submit} className="booking-form">
          {mode === 'signup' && (
            <label>
              Full name *
              <input className="input" required minLength={2} value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
          )}
          <label>
            Email *
            <input className="input" type="email" required value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label>
            Password *
            <input className="input" type="password" required minLength={mode === 'signup' ? 8 : 1}
              value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          {mode === 'signup' && (
            <label>
              Phone
              <input className="input" value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </label>
          )}
          {error && <p className="error-box">{error}</p>}
          <button className="btn btn-primary btn-lg" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}
