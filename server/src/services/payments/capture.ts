import { pool } from '../../db/pool.js';
import { enqueue, enqueueReminders } from '../notify/outbox.js';
import { executeRefund } from '../refunds.js';

/**
 * Mark a verified payment as captured and confirm its booking.
 * Idempotent: an already-captured order is a no-op success.
 *
 * Race with the hold expiring: the conditional UPDATE only wins while the
 * booking is still pending_payment. If the sweeper cancelled it first, the
 * money is captured and immediately auto-refunded, and the caller gets 410.
 */
export async function capturePayment(args: {
  orderId: string;
  paymentId: string;
  method?: string;
  raw?: unknown;
}) {
  const { rows: [payment] } = await pool.query('SELECT * FROM payments WHERE order_id = $1', [args.orderId]);
  if (!payment) throw Object.assign(new Error('Order not found'), { status: 404 });
  if (payment.status === 'captured') return { bookingId: payment.booking_id };

  const client = await pool.connect();
  let confirmed = false;
  try {
    await client.query('BEGIN');
    const { rows: [booking] } = await client.query(
      `UPDATE bookings SET status = 'confirmed', expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'pending_payment'
       RETURNING *`,
      [payment.booking_id]
    );
    await client.query(
      `UPDATE payments SET status = 'captured', payment_id = $2, method = $3, raw = $4, updated_at = now()
       WHERE id = $1`,
      [payment.id, args.paymentId, args.method ?? '', JSON.stringify(args.raw ?? {})]
    );
    await client.query(
      `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1, 'payment_captured', 'system', $2)`,
      [payment.booking_id, `${args.paymentId} · ₹${(payment.amount_cents / 100).toLocaleString('en-IN')}`]
    );
    if (booking) {
      confirmed = true;
      const { rows: [cust] } = await client.query('SELECT email FROM customers WHERE id = $1', [booking.customer_id]);
      // one combined "confirmed & paid" receipt email + reminders, now that it's real
      await enqueue(client, {
        bookingId: booking.id,
        template: 'receipt',
        recipient: cust.email,
        payload: { amountCents: payment.amount_cents },
      });
      await enqueueReminders(client, { id: booking.id, startsAt: booking.starts_at, recipient: cust.email });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (!confirmed) {
    // the hold expired before the money arrived — give it straight back
    await executeRefund(
      { ...payment, payment_id: args.paymentId },
      payment.amount_cents,
      'expired_capture',
      'system'
    );
    throw Object.assign(
      new Error('The payment window expired before payment completed. Your payment has been refunded in full.'),
      { status: 410 }
    );
  }
  return { bookingId: payment.booking_id };
}
