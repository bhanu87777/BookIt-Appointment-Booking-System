import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtDate } from '../format';
import { Stars } from '../components/Stars';
import type { Provider } from '../types';

interface AdminReview {
  id: number;
  booking_id: number;
  booking_code: string;
  provider_id: number;
  provider_name: string;
  emoji: string;
  customer_name: string;
  customer_email: string;
  service_name: string;
  rating: number;
  comment: string;
  hidden: boolean;
  created_at: string;
}

export default function Reviews() {
  const [reviews, setReviews] = useState<AdminReview[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    api.get<Provider[]>('/api/admin/providers').then(setProviders);
  }, []);

  useEffect(() => {
    const q = providerId ? `?providerId=${providerId}` : '';
    api.get<AdminReview[]>(`/api/admin/reviews${q}`).then(setReviews);
  }, [providerId]);

  async function toggle(r: AdminReview) {
    setBusyId(r.id);
    try {
      const updated = await api.patch<AdminReview>(`/api/admin/reviews/${r.id}`, { hidden: !r.hidden });
      setReviews((list) => list.map((x) => (x.id === r.id ? { ...x, hidden: updated.hidden } : x)));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="admin-title-row">
        <h1 className="admin-title">Reviews</h1>
        <select className="input" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          <option value="">All providers</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.emoji} {p.name}</option>
          ))}
        </select>
      </div>

      <div className="panel">
        {reviews.length === 0 && <p className="muted">No reviews yet.</p>}
        <table className="table">
          {reviews.length > 0 && (
            <thead>
              <tr>
                <th>Rating</th><th>Comment</th><th>Customer</th><th>Provider</th><th>Booking</th><th>Date</th><th></th>
              </tr>
            </thead>
          )}
          <tbody>
            {reviews.map((r) => (
              <tr key={r.id} className={r.hidden ? 'row-hidden' : ''}>
                <td><Stars value={r.rating} /></td>
                <td className="review-cell">{r.comment || <span className="muted">—</span>}</td>
                <td>{r.customer_name}<br /><span className="muted small">{r.customer_email}</span></td>
                <td><span className="cell-provider">{r.emoji} {r.provider_name}</span></td>
                <td className="mono">{r.booking_code}</td>
                <td className="small">{fmtDate(r.created_at)}</td>
                <td className="row-actions">
                  <button
                    className={`btn btn-xs ${r.hidden ? 'btn-ghost' : 'btn-danger-ghost'}`}
                    disabled={busyId === r.id}
                    onClick={() => toggle(r)}
                  >
                    {r.hidden ? 'Unhide' : 'Hide'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
