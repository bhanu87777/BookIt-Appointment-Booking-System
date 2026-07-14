import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { fmtDateTime, fmtTime, money, STATUS_LABELS } from '../format';
import type { Booking, Provider } from '../types';

export default function AdminBookings() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [filters, setFilters] = useState({ status: '', providerId: '', date: '', search: '' });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (filters.status) q.set('status', filters.status);
    if (filters.providerId) q.set('providerId', filters.providerId);
    if (filters.date) q.set('date', filters.date);
    if (filters.search) q.set('search', filters.search);
    api.get<Booking[]>(`/api/admin/bookings?${q}`).then(setBookings).catch((e) => setError(e.message));
  }, [filters]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get<Provider[]>('/api/admin/providers').then(setProviders).catch(() => {}); }, []);

  async function setStatus(b: Booking, status: string) {
    const labels: Record<string, string> = { cancelled: 'Cancel this booking and email the customer?', completed: 'Mark as completed?', no_show: 'Mark as no-show?' };
    if (!window.confirm(labels[status])) return;
    setBusyId(b.id);
    setError('');
    try {
      await api.patch(`/api/admin/bookings/${b.id}/status`, { status });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h1 className="admin-title">Bookings</h1>
      <div className="filter-bar">
        <input className="input" placeholder="Search code / name / email"
          value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
        <select className="input" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input" value={filters.providerId} onChange={(e) => setFilters({ ...filters, providerId: e.target.value })}>
          <option value="">All providers</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.emoji} {p.name}</option>)}
        </select>
        <input className="input" type="date" value={filters.date} onChange={(e) => setFilters({ ...filters, date: e.target.value })} />
        {(filters.status || filters.providerId || filters.date || filters.search) && (
          <button className="btn btn-ghost btn-sm" onClick={() => setFilters({ status: '', providerId: '', date: '', search: '' })}>
            Clear
          </button>
        )}
      </div>

      {error && <p className="error-box">{error}</p>}

      <div className="panel">
        <table className="table">
          <thead>
            <tr><th>Code</th><th>Customer</th><th>Provider / Service</th><th>When</th><th>Price</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {bookings.map((b) => (
              <tr key={b.id} className={busyId === b.id ? 'row-busy' : ''}>
                <td className="mono">{b.code}</td>
                <td>
                  <div>{b.customer_name}</div>
                  <div className="muted small">{b.customer_email}</div>
                </td>
                <td>
                  <div className="cell-provider">
                    <span className="mini-avatar" style={{ background: b.color }}>{b.emoji}</span>
                    {b.provider_name}
                  </div>
                  <div className="muted small">{b.service_name}</div>
                </td>
                <td>{fmtDateTime(b.starts_at)}<div className="muted small">ends {fmtTime(b.ends_at)}</div></td>
                <td>{money(b.price_cents)}</td>
                <td><span className={`badge badge-${b.status}`}>{STATUS_LABELS[b.status]}</span></td>
                <td className="row-actions">
                  {b.status === 'confirmed' && (
                    <>
                      <button className="btn btn-sm btn-ghost" title="Mark completed" onClick={() => setStatus(b, 'completed')}>✓</button>
                      <button className="btn btn-sm btn-ghost" title="No-show" onClick={() => setStatus(b, 'no_show')}>👻</button>
                      <button className="btn btn-sm btn-danger-ghost" title="Cancel" onClick={() => setStatus(b, 'cancelled')}>✕</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {bookings.length === 0 && (
              <tr><td colSpan={7} className="muted center">No bookings match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
