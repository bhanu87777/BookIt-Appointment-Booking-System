import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { fmtDateTime, money } from '../format';

interface AdminPayment {
  id: number;
  booking_code: string;
  booking_status: string;
  starts_at: string;
  provider: string;
  order_id: string;
  payment_id: string | null;
  amount_cents: number;
  status: string;
  method: string;
  error: string;
  created_at: string;
  customer_name: string;
  customer_email: string;
  provider_name: string;
  emoji: string;
  service_name: string;
  refunded_cents: number;
}

const PAYMENT_BADGES: Record<string, string> = {
  created: 'badge-no_show',
  captured: 'badge-confirmed',
  partially_refunded: 'badge-completed',
  refunded: 'badge-completed',
  failed: 'badge-cancelled',
};

export default function Payments() {
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [flash, setFlash] = useState('');

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (search) q.set('search', search);
    api.get<AdminPayment[]>(`/api/admin/payments?${q}`).then(setPayments).catch(() => {});
  }, [status, search]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function refund(p: AdminPayment) {
    const refundable = p.amount_cents - p.refunded_cents;
    const input = window.prompt(
      `Refund how much? (max ₹${(refundable / 100).toLocaleString('en-IN')})`,
      String(refundable / 100)
    );
    if (input === null) return;
    const amount = Math.round(parseFloat(input) * 100);
    if (!amount || amount <= 0 || amount > refundable) {
      setFlash('Invalid refund amount');
      return;
    }
    setBusyId(p.id);
    setFlash('');
    try {
      await api.post(`/api/admin/payments/${p.id}/refund`, { amountCents: amount });
      setFlash(`Refunded ${money(amount)} on ${p.booking_code}`);
      load();
    } catch (err) {
      setFlash(err instanceof ApiError ? err.message : 'Refund failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="admin-title-row">
        <h1 className="admin-title">Payments</h1>
        {flash && <span className="flash flash-ok">{flash}</span>}
      </div>

      <div className="filter-bar">
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="created">Created</option>
          <option value="captured">Captured</option>
          <option value="partially_refunded">Partially refunded</option>
          <option value="refunded">Refunded</option>
          <option value="failed">Failed</option>
        </select>
        <input className="input" placeholder="Search code / customer / order…"
          value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="panel">
        {payments.length === 0 && <p className="muted">No payments found.</p>}
        {payments.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Booking</th><th>Customer</th><th>Provider</th><th>Amount</th>
                <th>Status</th><th>Method</th><th>Created</th><th></th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => {
                const refundable = p.amount_cents - p.refunded_cents;
                return (
                  <tr key={p.id}>
                    <td>
                      <span className="mono">{p.booking_code}</span>
                      <div className="muted small">{p.service_name}</div>
                    </td>
                    <td>{p.customer_name}<div className="muted small">{p.customer_email}</div></td>
                    <td><span className="cell-provider">{p.emoji} {p.provider_name}</span></td>
                    <td>
                      {money(p.amount_cents)}
                      {p.refunded_cents > 0 && (
                        <div className="muted small">− {money(p.refunded_cents)} refunded</div>
                      )}
                    </td>
                    <td><span className={`badge ${PAYMENT_BADGES[p.status] ?? ''}`}>{p.status.replace(/_/g, ' ')}</span></td>
                    <td className="small">{p.method || p.provider}<div className="muted small mono">{p.order_id}</div></td>
                    <td className="small">{fmtDateTime(p.created_at)}</td>
                    <td className="row-actions">
                      {['captured', 'partially_refunded'].includes(p.status) && refundable > 0 && (
                        <button className="btn btn-danger-ghost btn-xs" disabled={busyId === p.id} onClick={() => refund(p)}>
                          Refund
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
