import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { computeSlots } from './slots.js';
import { enqueue, enqueueBookingLifecycle, enqueueReminders, voidReminders } from './notify/outbox.js';
import { computeDiscount, validateCoupon } from './coupons.js';
import { getBalance, maxRedeemablePoints, reverseRedemption, POINT_VALUE_CENTS } from './loyalty.js';
import { computeRefundCents, executeRefund, refundedSoFar, type RefundPolicy } from './refunds.js';
import { paymentProvider } from './payments/index.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const genCode = () =>
  'BK-' + Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');

export class BookingConflictError extends Error {
  status = 409;
  constructor(msg = 'That slot was just taken. Please pick another one.') {
    super(msg);
  }
}

export interface CreateBookingInput {
  providerId: number;
  serviceId: number;
  start: string; // ISO — must match a generated slot exactly
  customer: { name: string; email: string; phone?: string };
  notes?: string;
  couponCode?: string;
  /** Loyalty points to redeem — requires customerAuthId (set from the JWT). */
  redeemPoints?: number;
  /** Authenticated customer id, set by the ROUTE from the token, never from the body. */
  customerAuthId?: number;
}

export interface CreateBookingOptions {
  /** 'reminders_only' suppresses the per-booking confirmation (series). */
  notify?: 'full' | 'reminders_only';
  /** Link the booking to a recurring series. */
  seriesId?: number;
}

/**
 * Creates a booking with three layers of conflict protection:
 *
 *  1. pg_advisory_xact_lock(provider_id) — serialises concurrent booking
 *     attempts for the SAME provider (different providers stay fully
 *     parallel). The lock is released automatically at COMMIT/ROLLBACK.
 *  2. Slot re-validation inside the transaction — the requested start time
 *     must still be one of the slots the engine would offer right now. This
 *     also enforces schedule alignment, lead time, breaks and buffers, so a
 *     hand-crafted API call can't book 03:00 on a Sunday.
 *  3. The bookings_no_overlap EXCLUSION constraint — if anything slips
 *     through (or someone inserts via SQL), Postgres itself rejects the
 *     overlapping row with error 23P01.
 */
export async function createBooking(input: CreateBookingInput, opts: CreateBookingOptions = {}) {
  const client = await pool.connect();
  let committed: any = null;
  let due = 0;
  let couponCode: string | null = null;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [42, input.providerId]);

    // stale payment holds must never block a real customer between sweeper
    // ticks — expire them inline while we hold the provider lock
    await client.query(
      `WITH expired AS (
         UPDATE bookings SET status = 'cancelled', updated_at = now()
         WHERE provider_id = $1 AND status = 'pending_payment' AND expires_at < now()
         RETURNING id, coupon_code
       ), ev AS (
         INSERT INTO booking_events (booking_id, event, actor, detail)
         SELECT id, 'payment_expired', 'system', 'Payment window expired; slot released' FROM expired
       ), pay AS (
         UPDATE payments SET status = 'failed', error = 'expired', updated_at = now()
         WHERE booking_id IN (SELECT id FROM expired) AND status = 'created'
       )
       UPDATE coupons c SET used_count = greatest(c.used_count - 1, 0)
       FROM expired e WHERE e.coupon_code IS NOT NULL AND c.code = e.coupon_code`,
      [input.providerId]
    );

    const requested = new Date(input.start);
    if (isNaN(requested.getTime())) {
      throw Object.assign(new Error('Invalid start time'), { status: 400 });
    }
    const dateStr = `${requested.getFullYear()}-${String(requested.getMonth() + 1).padStart(2, '0')}-${String(requested.getDate()).padStart(2, '0')}`;

    const { slots, service, provider } = await computeSlots(
      client, input.providerId, input.serviceId, dateStr
    );
    const slot = slots.find((s) => new Date(s.start).getTime() === requested.getTime());
    if (!slot) throw new BookingConflictError('That slot is no longer available.');

    // upsert customer by email — a guest booking must not rewrite the profile
    // of a registered account (password_hash set); members edit via PATCH /me
    const { rows: [customer] } = await client.query(
      `INSERT INTO customers (name, email, phone)
       VALUES ($1, lower($2), $3)
       ON CONFLICT (email) DO UPDATE SET
         name  = CASE WHEN customers.password_hash IS NULL THEN EXCLUDED.name ELSE customers.name END,
         phone = CASE WHEN customers.password_hash IS NULL AND EXCLUDED.phone <> ''
                      THEN EXCLUDED.phone ELSE customers.phone END
       RETURNING *`,
      [input.customer.name.trim(), input.customer.email.trim(), input.customer.phone?.trim() ?? '']
    );

    // coupon: FOR UPDATE + atomic use-count increment is the authoritative
    // check (the public validate endpoint is advisory only)
    let discount = 0;
    if (input.couponCode) {
      const { rows: [coupon] } = await client.query(
        'SELECT * FROM coupons WHERE code = upper($1) FOR UPDATE', [input.couponCode.trim()]
      );
      const problem = validateCoupon(coupon, service.price_cents);
      if (problem) throw Object.assign(new Error(problem), { status: 400 });
      discount = computeDiscount(coupon, service.price_cents);
      couponCode = coupon.code;
      await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [coupon.id]);
    }

    // loyalty redemption: lock the customer row before summing the ledger so
    // two concurrent bookings can't both spend the same balance
    let pointsRedeemed = 0;
    if (input.redeemPoints && input.redeemPoints > 0) {
      if (!input.customerAuthId) {
        throw Object.assign(new Error('Sign in to redeem points'), { status: 401 });
      }
      if (input.customerAuthId !== customer.id) {
        throw Object.assign(new Error('Points can only be redeemed on bookings made with your own email'), { status: 403 });
      }
      await client.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customer.id]);
      const balance = await getBalance(client, customer.id);
      const maxAllowed = maxRedeemablePoints(balance, service.price_cents - discount);
      if (input.redeemPoints > maxAllowed) {
        throw Object.assign(
          new Error(maxAllowed > 0
            ? `You can redeem at most ${maxAllowed} points on this booking`
            : 'No points available to redeem on this booking'),
          { status: 400 }
        );
      }
      pointsRedeemed = input.redeemPoints;
      discount += pointsRedeemed * POINT_VALUE_CENTS;
    }

    // amount payable online per the service's payment policy
    const net = service.price_cents - discount;
    if (service.payment_policy === 'full') due = net;
    else if (service.payment_policy === 'deposit') due = Math.ceil((net * service.deposit_pct) / 100);
    if (due > 0) due = Math.max(due, 100); // gateway minimum ₹1

    const status = due > 0 ? 'pending_payment' : 'confirmed';
    const expiresAt = due > 0 ? new Date(Date.now() + config.payments.holdMinutes * 60_000) : null;

    const { rows: [booking] } = await client.query(
      `INSERT INTO bookings (code, provider_id, service_id, customer_id, starts_at, ends_at,
                             price_cents, discount_cents, coupon_code, points_redeemed, amount_due_cents,
                             expires_at, status, notes, series_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [genCode(), input.providerId, input.serviceId, customer.id, slot.start, slot.end,
       service.price_cents, discount, couponCode, pointsRedeemed, due,
       expiresAt, status, input.notes?.trim() ?? '', opts.seriesId ?? null]
    );

    if (pointsRedeemed > 0) {
      await client.query(
        `INSERT INTO loyalty_ledger (customer_id, booking_id, points, reason, detail)
         VALUES ($1, $2, $3, 'redeemed', $4)`,
        [customer.id, booking.id, -pointsRedeemed, `Redeemed on ${booking.code}`]
      );
    }

    await client.query(
      `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1,'created','customer',$2)`,
      [booking.id, `Booked ${service.name} via web${couponCode ? ` (coupon ${couponCode})` : ''}${due > 0 ? ' — awaiting payment' : ''}`]
    );

    // waitlist conversion: booking this day counts as taking the offer
    await client.query(
      `UPDATE waitlist SET status = 'converted'
       WHERE provider_id = $1 AND date = $2::date AND lower(email) = lower($3)
         AND status IN ('waiting', 'notified')`,
      [input.providerId, dateStr, customer.email]
    );

    // confirmed bookings notify now; pending ones get the receipt email +
    // reminders at capture time instead
    if (status === 'confirmed') {
      await enqueueBookingLifecycle(client, {
        id: booking.id,
        startsAt: booking.starts_at,
        recipient: customer.email,
      }, { confirmation: opts.notify !== 'reminders_only' });
    }

    await client.query('COMMIT');
    committed = { booking, customer, service, provider };
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err.code === '23P01') throw new BookingConflictError(); // exclusion_violation
    if (err.code === '23505' && err.constraint === 'bookings_code_key') {
      // astronomically unlikely code collision — caller can simply retry
      throw new BookingConflictError('Please retry your booking.');
    }
    throw err;
  } finally {
    client.release();
  }

  // gateway calls stay OUTSIDE the advisory-lock transaction
  let payment: any = null;
  if (due > 0) {
    try {
      const { orderId } = await paymentProvider.createOrder({
        amountCents: due,
        receipt: committed.booking.code,
      });
      const { rows: [payRow] } = await pool.query(
        `INSERT INTO payments (booking_id, provider, order_id, amount_cents) VALUES ($1,$2,$3,$4) RETURNING *`,
        [committed.booking.id, paymentProvider.name, orderId, due]
      );
      await pool.query(
        `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1,'payment_order_created','system',$2)`,
        [committed.booking.id, orderId]
      );
      payment = payRow;
    } catch {
      // compensate: release the slot and the coupon use, then surface a 502
      await pool.query(
        `UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [committed.booking.id]
      );
      if (couponCode) {
        await pool.query(
          `UPDATE coupons SET used_count = greatest(used_count - 1, 0) WHERE code = $1`, [couponCode]
        );
      }
      throw Object.assign(new Error('Payment gateway unavailable — please try again'), { status: 502 });
    }
  }
  return { ...committed, payment };
}

/**
 * Move a confirmed booking to a new slot — same provider, same service, same
 * price snapshot. Concurrency-safe the same way createBooking is: advisory
 * lock first (identical lock order, so create/reschedule serialize), slot
 * re-validation with the booking's own slot excluded, and the GiST exclusion
 * constraint as the last line of defense (an UPDATE is only checked against
 * OTHER rows, so shifting within the own slot's window is fine).
 */
export async function rescheduleBooking(bookingId: number, newStart: string, actor: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [pre] } = await client.query('SELECT provider_id FROM bookings WHERE id = $1', [bookingId]);
    if (!pre) throw Object.assign(new Error('Booking not found'), { status: 404 });
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [42, pre.provider_id]);

    const { rows: [booking] } = await client.query(
      `SELECT b.*, c.email AS customer_email, p.reschedule_cutoff_min
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN providers p ON p.id = b.provider_id
       WHERE b.id = $1 FOR UPDATE OF b`,
      [bookingId]
    );
    if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
    if (booking.status !== 'confirmed') {
      throw Object.assign(new Error(`A ${booking.status} booking cannot be rescheduled`), { status: 400 });
    }
    const now = new Date();
    const currentStart = new Date(booking.starts_at);
    if (currentStart <= now) {
      throw Object.assign(new Error('Past bookings cannot be rescheduled'), { status: 400 });
    }
    if (now.getTime() > currentStart.getTime() - booking.reschedule_cutoff_min * 60000) {
      throw Object.assign(
        new Error('This booking is too close to its start time to reschedule online — please cancel instead'),
        { status: 400 }
      );
    }

    const requested = new Date(newStart);
    if (isNaN(requested.getTime())) {
      throw Object.assign(new Error('Invalid start time'), { status: 400 });
    }
    const dateStr = `${requested.getFullYear()}-${String(requested.getMonth() + 1).padStart(2, '0')}-${String(requested.getDate()).padStart(2, '0')}`;

    // re-validates schedule windows, breaks, buffers, lead time and horizon
    const { slots } = await computeSlots(client, booking.provider_id, booking.service_id, dateStr, bookingId);
    const slot = slots.find((s) => new Date(s.start).getTime() === requested.getTime());
    if (!slot) throw new BookingConflictError('That slot is no longer available.');

    const { rows: [updated] } = await client.query(
      `UPDATE bookings SET starts_at = $2, ends_at = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [bookingId, slot.start, slot.end]
    );
    await client.query(
      `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1, 'rescheduled', $2, $3)`,
      [bookingId, actor, `From ${currentStart.toISOString()} to ${slot.start}`]
    );
    const { rows: [{ count: sequence }] } = await client.query(
      `SELECT count(*)::int AS count FROM booking_events WHERE booking_id = $1 AND event = 'rescheduled'`,
      [bookingId]
    );

    // reminders must fire relative to the NEW time (includeSent frees the unique index)
    await voidReminders(client, bookingId, { includeSent: true });
    await enqueueReminders(client, { id: bookingId, startsAt: slot.start, recipient: booking.customer_email });
    await enqueue(client, {
      bookingId,
      template: 'rescheduled',
      recipient: booking.customer_email,
      payload: { oldStartsAt: booking.starts_at, sequence },
    });

    await client.query('COMMIT');
    return updated;
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err.code === '23P01') throw new BookingConflictError();
    throw err;
  } finally {
    client.release();
  }
}

export interface CancelOptions {
  cancelledBy: 'you' | 'the provider';
  notify?: boolean; // default true; series cancellation sends one summary instead
  reason?: string;
  /** 'policy' (customer, default) applies the time-based refund policy;
   *  'full' (admin cancellations) always refunds everything captured. */
  refund?: 'policy' | 'full';
}

/**
 * The single cancellation hub — every cancel path (customer manage page,
 * customer account, admin status change, series cancel) goes through here so
 * reminder voiding, the cancellation email, refunds and the waitlist hook
 * can never diverge between entry points.
 */
export async function cancelBooking(bookingId: number, actor: string, opts: CancelOptions) {
  const client = await pool.connect();
  let booking: any;
  let plannedRefund: { payment: any; amountCents: number; policy: RefundPolicy } | null = null;
  let refundInfo: { amountCents: number; policy: RefundPolicy } | null = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT b.*, c.email AS customer_email
       FROM bookings b JOIN customers c ON c.id = b.customer_id
       WHERE b.id = $1 FOR UPDATE OF b`,
      [bookingId]
    );
    booking = rows[0];
    if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
    if (booking.status !== 'confirmed' && booking.status !== 'pending_payment') {
      throw Object.assign(new Error(`This booking is already ${booking.status}`), { status: 400 });
    }

    await client.query(`UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = $1`, [bookingId]);
    await client.query(
      `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1, 'cancelled', $2, $3)`,
      [bookingId, actor, opts.reason ?? '']
    );
    await voidReminders(client, bookingId);
    await reverseRedemption(client, booking);

    // paid booking? plan the refund now so the email can state the amount;
    // the gateway call happens after COMMIT
    const { rows: [payment] } = await client.query(
      `SELECT * FROM payments WHERE booking_id = $1 AND status IN ('captured', 'partially_refunded') FOR UPDATE`,
      [bookingId]
    );
    if (payment) {
      const refundable = payment.amount_cents - (await refundedSoFar(payment.id));
      if (refundable > 0) {
        const { refundCents, policy } =
          opts.refund === 'full'
            ? { refundCents: refundable, policy: 'full' as RefundPolicy }
            : computeRefundCents(refundable, new Date(booking.starts_at));
        refundInfo = { amountCents: refundCents, policy };
        if (refundCents > 0) plannedRefund = { payment, amountCents: refundCents, policy };
      }
    }

    if (opts.notify !== false) {
      // CANCEL .ics must carry a SEQUENCE >= the last REQUEST for the same UID
      const { rows: [{ count: reschedules }] } = await client.query(
        `SELECT count(*)::int AS count FROM booking_events WHERE booking_id = $1 AND event = 'rescheduled'`,
        [bookingId]
      );
      await enqueue(client, {
        bookingId,
        template: 'cancellation',
        recipient: booking.customer_email,
        payload: { cancelledBy: opts.cancelledBy, sequence: reschedules + 1, refund: refundInfo },
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (plannedRefund) {
    const reason = actor.startsWith('admin') ? 'admin_cancel' : 'customer_cancel';
    try {
      await executeRefund(plannedRefund.payment, plannedRefund.amountCents, reason, actor);
    } catch (err: any) {
      console.error(`[refund] booking ${bookingId} refund failed:`, err.message);
      await pool.query(
        `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1, 'refund_failed', 'system', $2)`,
        [bookingId, String(err.message ?? err).slice(0, 200)]
      );
    }
  }

  // slot freed → offer it to the waitlist (attached by the waitlist feature)
  await notifyWaitlistOfFreedSlot(booking);

  return { booking, refund: refundInfo };
}

/** Hook point for the waitlist feature; replaced with the real implementation there. */
let notifyWaitlistOfFreedSlot: (booking: any) => Promise<void> = async () => {};
export function setWaitlistHook(fn: (booking: any) => Promise<void>) {
  notifyWaitlistOfFreedSlot = fn;
}

/** Full booking row joined with customer, service, provider (for emails/API). */
export async function getBookingDetail(where: string, params: unknown[]) {
  const { rows } = await pool.query(
    `SELECT b.*,
            c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            s.name AS service_name, s.duration_min,
            p.name AS provider_name, p.title AS provider_title, p.business_type, p.emoji, p.color,
            p.reschedule_cutoff_min,
            EXISTS(SELECT 1 FROM reviews r WHERE r.booking_id = b.id) AS reviewed,
            sr.code AS series_code
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN services  s ON s.id = b.service_id
     JOIN providers p ON p.id = b.provider_id
     LEFT JOIN booking_series sr ON sr.id = b.series_id
     WHERE ${where}`,
    params
  );
  return rows[0] ?? null;
}
