import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { paymentProvider } from './payments/index.js';

export type RefundPolicy = 'full' | 'partial' | 'none';

/**
 * Cancellation refund policy: full refund up to REFUND_FULL_BEFORE_HOURS
 * before start, minus REFUND_FEE_PCT inside that window, nothing within
 * REFUND_NONE_WITHIN_HOURS of start.
 */
export function computeRefundCents(
  refundableCents: number,
  startsAt: Date,
  now = new Date()
): { refundCents: number; policy: RefundPolicy } {
  const hours = (startsAt.getTime() - now.getTime()) / 3600_000;
  const { fullBeforeHours, feePct, noneWithinHours } = config.refundPolicy;
  if (hours >= fullBeforeHours) return { refundCents: refundableCents, policy: 'full' };
  if (hours >= noneWithinHours) {
    return { refundCents: refundableCents - Math.ceil((refundableCents * feePct) / 100), policy: 'partial' };
  }
  return { refundCents: 0, policy: 'none' };
}

export async function refundedSoFar(paymentId: number): Promise<number> {
  const { rows: [{ sum }] } = await pool.query(
    `SELECT coalesce(sum(amount_cents), 0)::int AS sum FROM refunds WHERE payment_id = $1 AND status <> 'failed'`,
    [paymentId]
  );
  return sum;
}

/**
 * Refund a captured payment via the gateway adapter and record it.
 * amountCents is clamped to what is still refundable.
 */
export async function executeRefund(payment: any, amountCents: number, reason: string, actor: string) {
  const already = await refundedSoFar(payment.id);
  const refundable = payment.amount_cents - already;
  const amount = Math.min(amountCents, refundable);
  if (amount <= 0) throw Object.assign(new Error('Nothing left to refund on this payment'), { status: 400 });

  const result = await paymentProvider.refund({ paymentId: payment.payment_id, amountCents: amount });
  await pool.query(
    `INSERT INTO refunds (payment_id, provider_refund_id, amount_cents, reason, status, raw)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [payment.id, result.refundId, amount, reason, result.status, JSON.stringify(result.raw ?? {})]
  );
  const total = already + amount;
  await pool.query(
    `UPDATE payments SET status = $2, updated_at = now() WHERE id = $1`,
    [payment.id, total >= payment.amount_cents ? 'refunded' : 'partially_refunded']
  );
  await pool.query(
    `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1, 'refunded', $2, $3)`,
    [payment.booking_id, actor, `₹${(amount / 100).toLocaleString('en-IN')} refunded (${reason})`]
  );
  return { refundId: result.refundId, amountCents: amount };
}
