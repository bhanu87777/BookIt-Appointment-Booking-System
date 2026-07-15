import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { fmtDate } from '../format';
import type { Provider } from '../types';

interface WaitlistEntry {
  id: number;
  provider_id: number;
  provider_name: string;
  emoji: string;
  service_name: string;
  date: string;
  name: string;
  email: string;
  phone: string;
  status: 'waiting' | 'notified' | 'converted' | 'expired';
  notified_at: string | null;
  created_at: string;
}

const WL_BADGES: Record<string, string> = {
  waiting: 'badge-no_show',
  notified: 'badge-completed',
  converted: 'badge-confirmed',
  expired: 'badge-cancelled',
};

export default function Waitlist() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [status, setStatus] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    api.get<Provider[]>('/api/admin/providers').then(setProviders);
  }, []);

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (providerId) q.set('providerId', providerId);
    if (status) q.set('status', status);
    api.get<WaitlistEntry[]>(`/api/admin/waitlist?${q}`).then(setEntries).catch(() => {});
  }, [providerId, status]);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(id: number) {
    if (!window.confirm('Remove this entry from the waitlist?')) return;
    setBusyId(id);
    try {
      await api.del(`/api/admin/waitlist/${id}`);
      load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <h1 className="admin-title">Waitlist</h1>
      <div className="filter-bar">
        <select className="input" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          <option value="">All providers</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.emoji} {p.name}</option>
          ))}
        </select>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="waiting">Waiting</option>
          <option value="notified">Notified</option>
          <option value="converted">Converted</option>
          <option value="expired">Expired</option>
        </select>
      </div>

      <div className="panel">
        {entries.length === 0 && <p className="muted">Nobody is waiting right now.</p>}
        {entries.length > 0 && (
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Provider</th><th>Service</th><th>Customer</th><th>Status</th><th>Joined</th><th></th></tr>
            </thead>
            <tbody>
              {entries.map((w) => (
                <tr key={w.id}>
                  <td>{fmtDate(w.date)}</td>
                  <td><span className="cell-provider">{w.emoji} {w.provider_name}</span></td>
                  <td>{w.service_name}</td>
                  <td>{w.name}<div className="muted small">{w.email}</div></td>
                  <td><span className={`badge ${WL_BADGES[w.status]}`}>{w.status}</span></td>
                  <td className="small">{fmtDate(w.created_at)}</td>
                  <td className="row-actions">
                    {(w.status === 'waiting' || w.status === 'notified') && (
                      <button className="btn btn-danger-ghost btn-xs" disabled={busyId === w.id} onClick={() => remove(w.id)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
