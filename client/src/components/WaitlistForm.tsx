import { useState } from 'react';
import { api } from '../api';
import { useCustomer } from '../customer/auth';

interface Props {
  providerId: number;
  serviceId: number;
  date: string; // YYYY-MM-DD
}

/** Shown when a day has no free slots — joins the cancellation waitlist. */
export default function WaitlistForm({ providerId, serviceId, date }: Props) {
  const user = useCustomer();
  const [form, setForm] = useState({ name: user?.name ?? '', email: user?.email ?? '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/waitlist', { providerId, serviceId, date, customer: form });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join the waitlist');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p className="flash flash-ok">
        You're on the waitlist for this day — we'll email you the moment a slot opens. 🎉
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="waitlist-form">
      <strong>Fully booked — want us to watch this day for you?</strong>
      <p className="muted small">
        If a slot frees up, the first few people on the waitlist get an email. First to book wins.
      </p>
      <div className="form-row">
        <input className="input" placeholder="Your name" required minLength={2}
          value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="input" type="email" placeholder="Email" required
          value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </div>
      {error && <p className="error-box">{error}</p>}
      <button className="btn btn-ghost" disabled={busy}>
        {busy ? 'Joining…' : '🔔 Notify me if a slot opens'}
      </button>
    </form>
  );
}
