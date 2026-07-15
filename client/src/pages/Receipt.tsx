import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { fmtDateTime, fmtTime, money } from '../format';
import type { Booking } from '../types';

export default function Receipt() {
  const { code } = useParams();
  const [params] = useSearchParams();
  const email = params.get('email') ?? '';
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!code || !email) {
      setError('Open this page from your receipt email or booking confirmation.');
      return;
    }
    api.get<Booking>(`/api/bookings/${code}/receipt?email=${encodeURIComponent(email)}`)
      .then(setBooking)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load receipt'));
  }, [code, email]);

  if (error) {
    return (
      <div className="container center-page">
        <p className="error-box">{error}</p>
        <Link to="/manage" className="btn btn-ghost">Look up your booking</Link>
      </div>
    );
  }
  if (!booking) return <div className="container"><p className="muted">Loading receipt…</p></div>;

  const captured = (booking.payments ?? []).filter((p) =>
    ['captured', 'partially_refunded', 'refunded'].includes(p.status)
  );
  const paid = captured.reduce((s, p) => s + p.amount_cents, 0);
  const refunded = captured.flatMap((p) => p.refunds ?? []).reduce((s, r) => s + r.amount_cents, 0);
  const net = booking.price_cents - (booking.discount_cents ?? 0);
  const venueBalance = Math.max(0, net - paid);

  return (
    <div className="container narrow-page receipt-page">
      <div className="step-card receipt-card">
        <div className="receipt-head">
          <div>
            <div className="brand">📅 Book<span className="brand-accent">It</span></div>
            <p className="muted small">Appointment Booking System</p>
          </div>
          <div className="receipt-meta">
            <strong>Receipt</strong>
            <span className="mono">{booking.code}</span>
            <span className="muted small">{fmtDateTime(new Date())}</span>
          </div>
        </div>

        <div className="confirm-details">
          <div><span>Customer</span><strong>{booking.customer_name} ({booking.customer_email})</strong></div>
          <div><span>Provider</span><strong>{booking.emoji} {booking.provider_name}</strong></div>
          <div><span>Service</span><strong>{booking.service_name}</strong></div>
          <div><span>Appointment</span><strong>{fmtDateTime(booking.starts_at)} – {fmtTime(booking.ends_at)}</strong></div>
          <div><span>Status</span><strong>{booking.status}</strong></div>
        </div>

        <table className="table receipt-table">
          <tbody>
            <tr><td>Service price</td><td className="right">{money(booking.price_cents)}</td></tr>
            {(booking.discount_cents ?? 0) > 0 && (
              <tr><td>Discount{booking.coupon_code ? ` (${booking.coupon_code})` : ''}{(booking.points_redeemed ?? 0) > 0 ? ` · ${booking.points_redeemed} pts` : ''}</td>
                <td className="right">− {money(booking.discount_cents!)}</td></tr>
            )}
            <tr><td><strong>Total</strong></td><td className="right"><strong>{money(net)}</strong></td></tr>
            {captured.map((p) => (
              <tr key={p.id}>
                <td>Paid online ({p.method || p.provider} · <span className="mono">{p.payment_id ?? p.order_id}</span>)</td>
                <td className="right">{money(p.amount_cents)}</td>
              </tr>
            ))}
            {captured.flatMap((p) => p.refunds ?? []).map((r) => (
              <tr key={`r${r.id}`}>
                <td>Refund ({r.reason.replace(/_/g, ' ')})</td>
                <td className="right">− {money(r.amount_cents)}</td>
              </tr>
            ))}
            {venueBalance > 0 && booking.status !== 'cancelled' && (
              <tr><td>Payable at venue</td><td className="right">{money(venueBalance)}</td></tr>
            )}
          </tbody>
        </table>

        {refunded > 0 && (
          <p className="muted small">Refunds are returned to the original payment method within 3–5 business days.</p>
        )}

        <div className="btn-row no-print">
          <button className="btn btn-primary" onClick={() => window.print()}>🖨️ Print / Save as PDF</button>
          <Link className="btn btn-ghost" to={`/manage?code=${booking.code}&email=${encodeURIComponent(email)}`}>
            Manage booking
          </Link>
        </div>
      </div>
    </div>
  );
}
