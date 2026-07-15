import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { fmtDate, fmtDateTime, money, STATUS_LABELS } from '../format';
import type { Booking } from '../types';
import type { CrmCustomer } from './Customers';

type Detail = CrmCustomer & { notes: string; bookings: Booking[] };

export default function CustomerDetail() {
  const { id } = useParams();
  const [customer, setCustomer] = useState<Detail | null>(null);
  const [notes, setNotes] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Detail>(`/api/admin/customers/${id}`).then((c) => {
      setCustomer(c);
      setNotes(c.notes);
    }).catch(() => {});
  }, [id]);

  async function saveNotes() {
    setBusy(true);
    setFlash('');
    try {
      await api.patch(`/api/admin/customers/${id}/notes`, { notes });
      setFlash('Notes saved');
    } catch (err) {
      setFlash(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  if (!customer) return <p className="muted">Loading customer…</p>;

  const tiles = [
    { label: 'Bookings', value: customer.booking_count, icon: '🗓️' },
    { label: 'Lifetime spend', value: money(customer.total_spend_cents), icon: '💰' },
    { label: 'Points balance', value: customer.points_balance, icon: '⭐' },
    { label: 'No-shows', value: customer.no_show_count, icon: '🚫' },
    { label: 'Last visit', value: customer.last_visit ? fmtDate(customer.last_visit) : '—', icon: '📍' },
  ];

  return (
    <>
      <div className="admin-title-row">
        <h1 className="admin-title">
          {customer.name} {customer.has_account && <span title="Has an account">👤</span>}
        </h1>
        <Link className="btn btn-ghost btn-sm" to="/admin/customers">← All customers</Link>
      </div>
      <p className="muted">
        {customer.email}{customer.phone ? ` · ${customer.phone}` : ''} · customer since {fmtDate(customer.created_at)}
      </p>

      <div className="stat-grid">
        {tiles.map((t) => (
          <div key={t.label} className="stat-card">
            <span className="stat-icon">{t.icon}</span>
            <div>
              <div className="stat-value">{t.value}</div>
              <div className="stat-label">{t.label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Private notes</h2>
          {flash && <span className="flash flash-ok">{flash}</span>}
        </div>
        <textarea className="input" rows={3} maxLength={5000} value={notes}
          placeholder="Preferences, allergies, VIP status…"
          onChange={(e) => setNotes(e.target.value)} />
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={saveNotes}>
            {busy ? 'Saving…' : 'Save notes'}
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Booking history</h2>
        {customer.bookings.length === 0 && <p className="muted">No bookings yet.</p>}
        {customer.bookings.length > 0 && (
          <table className="table">
            <thead>
              <tr><th>Code</th><th>Provider</th><th>Service</th><th>When</th><th>Paid</th><th>Status</th></tr>
            </thead>
            <tbody>
              {customer.bookings.map((b) => (
                <tr key={b.id}>
                  <td className="mono">{b.code}</td>
                  <td><span className="cell-provider"><span className="mini-avatar" style={{ background: b.color }}>{b.emoji}</span> {b.provider_name}</span></td>
                  <td>{b.service_name}</td>
                  <td className="small">{fmtDateTime(b.starts_at)}</td>
                  <td>{money(b.price_cents - (b.discount_cents ?? 0))}</td>
                  <td><span className={`badge badge-${b.status}`}>{STATUS_LABELS[b.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
