import { pool } from '../db/pool.js';
import {
  BookingConflictError,
  cancelBooking,
  createBooking,
  getBookingDetail,
  type CreateBookingInput,
} from './booking.js';
import { enqueue } from './notify/outbox.js';
import { extraRenderers, layout, fmt } from './notify/templates.js';
import { buildIcs, bookingToIcsEvent } from './ics.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const genSeriesCode = () =>
  'SR-' + Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');

export interface CreateSeriesInput extends CreateBookingInput {
  frequency: 'weekly' | 'biweekly';
  occurrences: number; // 2..12
}

/** Same wall-clock time N days later (local date math, DST-safe). */
function addLocalDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Book a weekly/biweekly series with skip-and-report semantics: the slot the
 * user actually picked (occurrence 0) must succeed or nothing is created;
 * later occurrences that conflict or fall outside the booking horizon are
 * skipped and reported. Every occurrence runs through the ordinary hardened
 * createBooking transaction — the exclusion constraint, reminders and
 * cancellation all work untouched.
 */
export async function createSeries(input: CreateSeriesInput) {
  const { rows: [service] } = await pool.query(
    'SELECT * FROM services WHERE id = $1 AND provider_id = $2 AND active',
    [input.serviceId, input.providerId]
  );
  if (!service) throw Object.assign(new Error('Service not found'), { status: 404 });
  if (service.payment_policy !== 'none') {
    throw Object.assign(
      new Error('Recurring bookings are currently available only for pay-at-venue services'),
      { status: 400 }
    );
  }

  const base: CreateBookingInput = { ...input, couponCode: undefined, redeemPoints: undefined };
  const stepDays = input.frequency === 'weekly' ? 7 : 14;

  // occurrence 0 — must succeed, else the whole request fails
  const first = await createBooking(base, { notify: 'reminders_only' });

  const { rows: [series] } = await pool.query(
    `INSERT INTO booking_series (code, provider_id, service_id, customer_id, frequency, occurrences)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [genSeriesCode(), input.providerId, input.serviceId, first.customer.id, input.frequency, input.occurrences]
  );
  await pool.query('UPDATE bookings SET series_id = $1 WHERE id = $2', [series.id, first.booking.id]);

  const horizonEnd = new Date(Date.now() + first.provider.booking_horizon_days * 24 * 3600_000);
  const booked: any[] = [first.booking];
  const skipped: { start: string; reason: string }[] = [];

  for (let k = 1; k < input.occurrences; k++) {
    const start = addLocalDays(new Date(input.start), k * stepDays);
    if (start > horizonEnd) {
      skipped.push({ start: start.toISOString(), reason: "Outside the provider's booking window" });
      continue;
    }
    try {
      const r = await createBooking(
        { ...base, start: start.toISOString() },
        { notify: 'reminders_only', seriesId: series.id }
      );
      booked.push(r.booking);
    } catch (err: any) {
      skipped.push({
        start: start.toISOString(),
        reason: err instanceof BookingConflictError ? 'Slot already taken' : err.message ?? 'Unavailable',
      });
    }
  }

  // one summary email for the whole series (occurrences suppressed their own)
  await enqueue(pool, {
    bookingId: first.booking.id,
    template: 'series_summary',
    recipient: first.customer.email,
    payload: {
      seriesCode: series.code,
      frequency: input.frequency,
      booked: booked.map((b) => ({ code: b.code, starts_at: b.starts_at, ends_at: b.ends_at })),
      skipped,
    },
  });

  const details = [];
  for (const b of booked) details.push(await getBookingDetail('b.id = $1', [b.id]));
  return { series, booked: details, skipped };
}

export async function cancelSeries(code: string, email: string) {
  const { rows: [series] } = await pool.query(
    `SELECT s.*, c.email AS customer_email
     FROM booking_series s JOIN customers c ON c.id = s.customer_id
     WHERE upper(s.code) = upper($1) AND c.email = lower($2)`,
    [code.trim(), email.trim()]
  );
  if (!series) throw Object.assign(new Error('No series found for that code and email'), { status: 404 });

  const { rows: remaining } = await pool.query(
    `SELECT id, code, starts_at, ends_at FROM bookings
     WHERE series_id = $1 AND status = 'confirmed' AND starts_at > now()
     ORDER BY starts_at`,
    [series.id]
  );
  if (!remaining.length) {
    throw Object.assign(new Error('No upcoming bookings remain in this series'), { status: 400 });
  }

  // per-occurrence emails suppressed — one summary goes out instead;
  // cancelBooking still handles reminders, refunds and the waitlist hook
  for (const b of remaining) {
    await cancelBooking(b.id, 'customer', {
      cancelledBy: 'you',
      notify: false,
      reason: `Series ${series.code} cancelled`,
    });
  }

  await enqueue(pool, {
    bookingId: remaining[0].id,
    template: 'series_cancelled',
    recipient: series.customer_email,
    payload: {
      seriesCode: series.code,
      cancelled: remaining.map((b) => ({ code: b.code, starts_at: b.starts_at, ends_at: b.ends_at })),
    },
  });

  return { cancelled: remaining.length };
}

// ------------------------------------------------------------- email renderers

const occurrenceRows = (items: any[]) =>
  items.map((b) => `<li>${fmt(b.starts_at)} <span style="color:#94a3b8;font-family:monospace">[${b.code}]</span></li>`).join('');

extraRenderers.series_summary = (payload, detail) => {
  const events = payload.booked.map((b: any) =>
    bookingToIcsEvent({ ...detail, code: b.code, starts_at: b.starts_at, ends_at: b.ends_at })
  );
  const skippedBlock = payload.skipped?.length
    ? `<p style="background:#fef3c7;color:#92400e;padding:10px 14px;border-radius:10px">
         <strong>${payload.skipped.length} date(s) could not be booked:</strong><br/>
         ${payload.skipped.map((s: any) => `${fmt(s.start)} — ${s.reason}`).join('<br/>')}
       </p>`
    : '';
  const html = layout(`Series confirmed 📆 (${payload.booked.length} sessions)`, '#16a34a', `
    <p>Hi ${detail.customer_name},</p>
    <p>Your ${payload.frequency} series of <strong>${detail.service_name}</strong> with
       <strong>${detail.provider_name}</strong> is booked:</p>
    <ul>${occurrenceRows(payload.booked)}</ul>
    ${skippedBlock}
    <p style="color:#64748b;font-size:13px">Series code: <strong style="font-family:monospace">${payload.seriesCode}</strong>.
       A calendar invite with every session is attached. Each session can also be managed individually with its own code.</p>`);
  return {
    subject: `Series confirmed: ${payload.booked.length}× ${detail.service_name} [${payload.seriesCode}]`,
    html,
    attachments: [{
      filename: `series-${payload.seriesCode}.ics`,
      content: buildIcs(events, 'REQUEST'),
      contentType: 'text/calendar; charset=utf-8; method=REQUEST',
    }],
  };
};

extraRenderers.series_cancelled = (payload, detail) => {
  const events = payload.cancelled.map((b: any) =>
    bookingToIcsEvent({ ...detail, code: b.code, starts_at: b.starts_at, ends_at: b.ends_at }, 1, true)
  );
  const html = layout('Series cancelled', '#dc2626', `
    <p>Hi ${detail.customer_name},</p>
    <p>The remaining ${payload.cancelled.length} session(s) of series
       <strong style="font-family:monospace">${payload.seriesCode}</strong> were cancelled. The slots have been released.</p>
    <ul>${occurrenceRows(payload.cancelled)}</ul>`);
  return {
    subject: `Series cancelled: ${payload.seriesCode} (${payload.cancelled.length} sessions)`,
    html,
    attachments: [{
      filename: `series-${payload.seriesCode}.ics`,
      content: buildIcs(events, 'CANCEL'),
      contentType: 'text/calendar; charset=utf-8; method=CANCEL',
    }],
  };
};
