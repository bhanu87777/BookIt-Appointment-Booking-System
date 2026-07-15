import type pg from 'pg';
import { pool } from '../db/pool.js';

export const POINT_VALUE_CENTS = 100; // 1 point = ₹1 off
export const EARN_PER_CENTS = 1000;   // 1 point per ₹10 actually paid (net)
export const MAX_REDEEM_PRICE_PCT = 50; // points may cover at most 50% of the price

type Db = pg.Pool | pg.PoolClient;

export async function getBalance(db: Db, customerId: number): Promise<number> {
  const { rows: [{ balance }] } = await db.query(
    'SELECT coalesce(sum(points), 0)::int AS balance FROM loyalty_ledger WHERE customer_id = $1',
    [customerId]
  );
  return balance;
}

export function maxRedeemablePoints(balance: number, netPriceCents: number): number {
  return Math.max(0, Math.min(balance, Math.floor((netPriceCents * MAX_REDEEM_PRICE_PCT) / 100 / POINT_VALUE_CENTS)));
}

/**
 * Earn points when a booking completes. Guests earn too — the points sit on
 * their customer row and become visible the moment they sign up. Idempotent
 * via the (booking_id, reason) partial unique index.
 */
export async function earnForCompletion(booking: any) {
  const points = Math.floor((booking.price_cents - (booking.discount_cents ?? 0)) / EARN_PER_CENTS);
  if (points <= 0) return;
  await pool.query(
    `INSERT INTO loyalty_ledger (customer_id, booking_id, points, reason, detail)
     VALUES ($1, $2, $3, 'earned_completed', $4)
     ON CONFLICT DO NOTHING`,
    [booking.customer_id, booking.id, points, `Completed ${booking.code}`]
  );
}

/** Give redeemed points back when a booking with a redemption is cancelled. */
export async function reverseRedemption(db: Db, booking: any) {
  if (!booking.points_redeemed || booking.points_redeemed <= 0) return;
  await db.query(
    `INSERT INTO loyalty_ledger (customer_id, booking_id, points, reason, detail)
     VALUES ($1, $2, $3, 'redemption_reversed', $4)
     ON CONFLICT DO NOTHING`,
    [booking.customer_id, booking.id, booking.points_redeemed, `${booking.code} cancelled — points returned`]
  );
}
