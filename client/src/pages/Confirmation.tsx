import { Link, useLocation } from 'react-router-dom';
import { fmtDateTime, fmtTime, money } from '../format';
import type { Booking } from '../types';

export default function Confirmation() {
  const booking = (useLocation().state as { booking?: Booking } | null)?.booking;

  if (!booking) {
    return (
      <div className="container center-page">
        <p className="muted">Nothing to show here.</p>
        <Link to="/" className="btn btn-primary">Go home</Link>
      </div>
    );
  }

  return (
    <div className="container center-page">
      <div className="confirm-card">
        <div className="confirm-tick">✓</div>
        <h1>Booking confirmed!</h1>
        <p className="muted">
          A confirmation email is on its way to <strong>{booking.customer_email}</strong>.
        </p>
        <div className="confirm-code">
          <span>Booking code</span>
          <strong>{booking.code}</strong>
        </div>
        <div className="confirm-details">
          <div><span>Provider</span><strong>{booking.emoji} {booking.provider_name}</strong></div>
          <div><span>Service</span><strong>{booking.service_name}</strong></div>
          <div><span>When</span><strong>{fmtDateTime(booking.starts_at)} – {fmtTime(booking.ends_at)}</strong></div>
          <div><span>Price</span><strong>{money(booking.price_cents)}</strong></div>
        </div>
        <div className="confirm-actions">
          <Link className="btn btn-ghost" to={`/manage?code=${booking.code}&email=${encodeURIComponent(booking.customer_email)}`}>
            Manage booking
          </Link>
          <Link className="btn btn-primary" to="/">Book another</Link>
        </div>
      </div>
    </div>
  );
}
