import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { fmtDateTime, fmtTime, money, STATUS_LABELS } from '../format';
import type { Booking } from '../types';
import RescheduleDialog from '../components/RescheduleDialog';
import ReviewForm from '../components/ReviewForm';

export default function Manage() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);

  async function lookup(e?: React.FormEvent) {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      setBooking(await api.get<Booking>(
        `/api/bookings/lookup?code=${encodeURIComponent(code.trim())}&email=${encodeURIComponent(email.trim())}`
      ));
    } catch (err) {
      setBooking(null);
      setError(err instanceof ApiError ? err.message : 'Lookup failed');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (params.get('code') && params.get('email')) void lookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function cancel() {
    if (!booking) return;
    let msg = 'Cancel this booking? The slot will be released.';
    try {
      const p = await api.get<{ paid: boolean; refund: { amountCents: number; paidCents: number } | null }>(
        `/api/bookings/${booking.code}/refund-preview?email=${encodeURIComponent(email.trim())}`
      );
      if (p.paid && p.refund) {
        msg =
          p.refund.amountCents > 0
            ? `Cancel this booking? ${money(p.refund.amountCents)} of the ${money(p.refund.paidCents)} you paid will be refunded.`
            : 'Cancel this booking? Per the cancellation policy, no refund applies this close to the appointment.';
      }
    } catch {
      /* preview is best-effort */
    }
    if (!window.confirm(msg)) return;
    setBusy(true);
    setError('');
    try {
      setBooking(await api.post<Booking>(`/api/bookings/${booking.code}/cancel`, { email }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cancellation failed');
    } finally {
      setBusy(false);
    }
  }

  const upcoming = booking && booking.status === 'confirmed' && new Date(booking.starts_at) > new Date();
  const canReschedule =
    upcoming &&
    new Date() <
      new Date(new Date(booking!.starts_at).getTime() - (booking!.reschedule_cutoff_min ?? 120) * 60000);

  return (
    <div className="container narrow-page">
      <h1>Manage your booking</h1>
      <p className="muted">Enter the booking code from your confirmation email.</p>

      <form onSubmit={lookup} className="lookup-form">
        <input className="input" placeholder="Booking code (e.g. BK-7F3K2A)" required
          value={code} onChange={(e) => setCode(e.target.value)} />
        <input className="input" type="email" placeholder="Email used for booking" required
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Looking up…' : 'Find booking'}</button>
      </form>

      {error && <p className="error-box">{error}</p>}

      {booking && (
        <div className="manage-card">
          <div className="manage-head">
            <div className="provider-avatar" style={{ background: booking.color }}>{booking.emoji}</div>
            <div>
              <h2>{booking.provider_name}</h2>
              <p className="muted">{booking.service_name}</p>
            </div>
            <span className={`badge badge-${booking.status}`}>{STATUS_LABELS[booking.status]}</span>
          </div>
          <div className="confirm-details">
            <div><span>Code</span><strong>{booking.code}</strong></div>
            <div><span>When</span><strong>{fmtDateTime(booking.starts_at)} – {fmtTime(booking.ends_at)}</strong></div>
            <div><span>Booked by</span><strong>{booking.customer_name}</strong></div>
            <div><span>Price</span><strong>{money(booking.price_cents)}</strong></div>
            {(booking.discount_cents ?? 0) > 0 && (
              <div><span>Discount</span><strong>− {money(booking.discount_cents!)}</strong></div>
            )}
            {booking.refund && booking.refund.amountCents > 0 && (
              <div><span>Refund</span><strong>{money(booking.refund.amountCents)} initiated</strong></div>
            )}
            {booking.notes && <div><span>Notes</span><strong>{booking.notes}</strong></div>}
          </div>
          {booking.status === 'pending_payment' && booking.expires_at && new Date(booking.expires_at) > new Date() && (
            <Link
              className="btn btn-primary"
              to={`/checkout/${booking.code}?email=${encodeURIComponent(email.trim())}`}
            >
              💳 Complete payment
            </Link>
          )}
          {(booking.amount_due_cents ?? 0) > 0 && booking.status !== 'pending_payment' && (
            <Link className="panel-link" to={`/receipt/${booking.code}?email=${encodeURIComponent(email.trim())}`}>
              🧾 View receipt
            </Link>
          )}
          {upcoming && (
            <div className="btn-row">
              {canReschedule && (
                <button className="btn btn-ghost" onClick={() => setRescheduling((r) => !r)} disabled={busy}>
                  🔁 Reschedule
                </button>
              )}
              <button className="btn btn-danger" onClick={cancel} disabled={busy}>
                {busy ? 'Cancelling…' : 'Cancel booking'}
              </button>
            </div>
          )}
          {booking.series_code && upcoming && (
            <div className="series-cancel-row">
              <span className="muted small">
                Part of series <strong className="mono">{booking.series_code}</strong>
              </span>
              <button
                className="btn btn-danger-ghost btn-sm"
                disabled={busy}
                onClick={async () => {
                  if (!window.confirm('Cancel ALL remaining sessions in this series?')) return;
                  setBusy(true);
                  setError('');
                  try {
                    await api.post(`/api/bookings/series/${booking.series_code}/cancel`, { email });
                    void lookup();
                  } catch (err) {
                    setError(err instanceof ApiError ? err.message : 'Series cancellation failed');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Cancel remaining series
              </button>
            </div>
          )}
          {rescheduling && booking && (
            <RescheduleDialog
              booking={booking}
              email={email}
              onDone={(b) => {
                setBooking(b);
                setRescheduling(false);
              }}
              onClose={() => setRescheduling(false)}
            />
          )}
          {booking.status === 'completed' && !booking.reviewed && (
            <ReviewForm
              onSubmit={async (rating, comment) => {
                await api.post(`/api/bookings/${booking.code}/review`, { email, rating, comment });
                setBooking({ ...booking, reviewed: true });
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
