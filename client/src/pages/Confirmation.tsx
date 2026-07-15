import { Link, useLocation } from 'react-router-dom';
import { fmtDateTime, fmtTime, money } from '../format';
import type { Booking } from '../types';

interface SeriesResult {
  series: { code: string };
  booked: Booking[];
  skipped: { start: string; reason: string }[];
}

export default function Confirmation() {
  const state = useLocation().state as { booking?: Booking; series?: SeriesResult } | null;
  const booking = state?.booking;
  const series = state?.series;

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
        <h1>{series ? `${series.booked.length} sessions booked!` : 'Booking confirmed!'}</h1>
        <p className="muted">
          A confirmation email is on its way to <strong>{booking.customer_email}</strong>.
        </p>
        <div className="confirm-code">
          <span>{series ? 'Series code' : 'Booking code'}</span>
          <strong>{series ? series.series.code : booking.code}</strong>
        </div>
        {series && (
          <div className="series-summary">
            <ul className="series-list">
              {series.booked.map((b) => (
                <li key={b.code}>
                  ✅ {fmtDateTime(b.starts_at)} <span className="mono muted small">[{b.code}]</span>
                </li>
              ))}
            </ul>
            {series.skipped.length > 0 && (
              <div className="error-box">
                <strong>{series.skipped.length} date(s) couldn't be booked:</strong>
                <ul className="series-list">
                  {series.skipped.map((s) => (
                    <li key={s.start}>{fmtDateTime(s.start)} — {s.reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <div className="confirm-details">
          <div><span>Provider</span><strong>{booking.emoji} {booking.provider_name}</strong></div>
          <div><span>Service</span><strong>{booking.service_name}</strong></div>
          <div><span>When</span><strong>{fmtDateTime(booking.starts_at)} – {fmtTime(booking.ends_at)}</strong></div>
          <div><span>Price</span><strong>{money(booking.price_cents)}</strong></div>
          {(booking.discount_cents ?? 0) > 0 && (
            <div>
              <span>Discount{booking.coupon_code ? ` (${booking.coupon_code})` : ''}</span>
              <strong>− {money(booking.discount_cents!)}</strong>
            </div>
          )}
          {(booking.amount_due_cents ?? 0) > 0 && (
            <div><span>Paid online</span><strong>{money(booking.amount_due_cents!)}</strong></div>
          )}
          {(booking.amount_due_cents ?? 0) > 0 &&
            booking.price_cents - (booking.discount_cents ?? 0) - booking.amount_due_cents! > 0 && (
            <div>
              <span>Due at venue</span>
              <strong>{money(booking.price_cents - (booking.discount_cents ?? 0) - booking.amount_due_cents!)}</strong>
            </div>
          )}
        </div>
        <div className="confirm-actions">
          {(booking.amount_due_cents ?? 0) > 0 && (
            <Link className="btn btn-ghost" to={`/receipt/${booking.code}?email=${encodeURIComponent(booking.customer_email)}`}>
              🧾 Receipt
            </Link>
          )}
          <Link className="btn btn-ghost" to={`/manage?code=${booking.code}&email=${encodeURIComponent(booking.customer_email)}`}>
            Manage booking
          </Link>
          <Link className="btn btn-primary" to="/">Book another</Link>
        </div>
      </div>
    </div>
  );
}
