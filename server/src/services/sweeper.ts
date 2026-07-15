import { pool } from '../db/pool.js';

const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Cancels payment holds whose window expired, releasing their slot (the
 * exclusion constraint stops covering a row the moment status leaves the
 * active set). createBooking also runs an inline expiry pass per provider,
 * so this sweeper is global hygiene, not the only line of defense.
 */
export function startSweeper() {
  timer = setInterval(() => void sweep(), TICK_MS);
  timer.unref();
  void sweep();
  console.log('🧹 Payment-hold sweeper started (60s tick)');
}

export function stopSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function sweep() {
  if (running) return;
  running = true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: expired } = await client.query(
      `UPDATE bookings SET status = 'cancelled', updated_at = now()
       WHERE status = 'pending_payment' AND expires_at < now()
       RETURNING id, coupon_code`
    );
    if (expired.length) {
      const ids = expired.map((b) => b.id);
      await client.query(
        `INSERT INTO booking_events (booking_id, event, actor, detail)
         SELECT id, 'payment_expired', 'system', 'Payment window expired; slot released'
         FROM unnest($1::int[]) AS id`,
        [ids]
      );
      await client.query(
        `UPDATE payments SET status = 'failed', error = 'expired', updated_at = now()
         WHERE booking_id = ANY($1) AND status = 'created'`,
        [ids]
      );
      const codes = expired.map((b) => b.coupon_code).filter(Boolean);
      if (codes.length) {
        await client.query(
          `UPDATE coupons SET used_count = greatest(used_count - 1, 0) WHERE code = ANY($1)`,
          [codes]
        );
      }
      console.log(`🧹 Released ${expired.length} expired payment hold(s)`);
    }
    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('[sweeper] failed:', err.message);
  } finally {
    client.release();
    running = false;
  }
}
