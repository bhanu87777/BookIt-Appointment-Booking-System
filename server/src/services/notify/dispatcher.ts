import { pool } from '../../db/pool.js';
import { getBookingDetail } from '../booking.js';
import { channels } from './channels.js';
import { render } from './templates.js';
import type { NotificationRow } from './types.js';

const TICK_MS = 30_000;
const BATCH = 20;
const MAX_ATTEMPTS = 5;

let timer: NodeJS.Timeout | null = null;
let ticking = false;

export function startDispatcher() {
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  void tick(); // catch up immediately on boot
  console.log('📮 Notification dispatcher started (30s tick)');
}

export function stopDispatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Nudge the dispatcher after enqueueing an immediate notification. */
export function wake() {
  setImmediate(() => void tick());
}

async function tick() {
  if (ticking) return; // in-process re-entrancy guard; SKIP LOCKED covers multi-process
  ticking = true;
  try {
    const claimed = await claim();
    for (const n of claimed) await deliver(n);
    await housekeeping();
  } catch (err: any) {
    console.error('[notify] tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

/**
 * Claim due rows and reserve the attempt in one statement — attempts+1 and
 * the backoff cursor are written up front, so no transaction stays open
 * while SMTP runs and a crashed process simply retries after the backoff.
 */
async function claim(): Promise<NotificationRow[]> {
  const { rows } = await pool.query(
    `WITH due AS (
       SELECT id FROM notifications
       WHERE status = 'pending' AND scheduled_for <= now()
         AND next_attempt_at <= now() AND attempts < $2
       ORDER BY scheduled_for
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE notifications n
     SET attempts = n.attempts + 1,
         next_attempt_at = now() + (interval '1 minute' * power(4, n.attempts))
     FROM due WHERE n.id = due.id
     RETURNING n.*`,
    [BATCH, MAX_ATTEMPTS]
  );
  return rows;
}

async function deliver(n: NotificationRow) {
  try {
    let detail: any = null;
    if (n.booking_id) {
      detail = await getBookingDetail('b.id = $1', [n.booking_id]);
      if (!detail) throw new Error('Booking no longer exists');
      // send-time freshness guard: never send a reminder for a booking that
      // is no longer confirmed or already started (covers long downtime too)
      if (
        (n.template === 'reminder_24h' || n.template === 'reminder_1h') &&
        (detail.status !== 'confirmed' || new Date(detail.starts_at) <= new Date())
      ) {
        await pool.query(`UPDATE notifications SET status = 'void' WHERE id = $1`, [n.id]);
        return;
      }
    }

    const channel = channels[n.channel];
    if (!channel) throw new Error(`Channel ${n.channel} not configured`);
    const msg = render(n, detail);
    await channel.send(n.recipient, msg);

    await pool.query(
      `UPDATE notifications SET status = 'sent', sent_at = now(), last_error = '' WHERE id = $1`,
      [n.id]
    );
    if (n.booking_id) {
      await pool.query(
        `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1, 'email_sent', 'system', $2)`,
        [n.booking_id, msg.subject]
      );
    }
  } catch (err: any) {
    // claim already incremented attempts and set the backoff cursor
    const exhausted = n.attempts >= MAX_ATTEMPTS;
    console.error(`[notify] ${n.template} #${n.id} attempt ${n.attempts} failed:`, err.message);
    await pool.query(
      `UPDATE notifications SET last_error = $2, status = CASE WHEN $3 THEN 'failed' ELSE status END WHERE id = $1`,
      [n.id, String(err.message ?? err).slice(0, 500), exhausted]
    );
    if (exhausted && n.booking_id) {
      await pool.query(
        `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1, 'email_failed', 'system', $2)`,
        [n.booking_id, `${n.template}: ${String(err.message ?? err).slice(0, 200)}`]
      );
    }
  }
}

/** Cheap periodic hygiene, piggybacked on the tick. */
async function housekeeping() {
  // waitlist expiry lands here in the waitlist feature; guarded so the tick
  // works even before that table exists
  await pool
    .query(`UPDATE waitlist SET status = 'expired'
            WHERE date < current_date AND status IN ('waiting', 'notified')`)
    .catch(() => {});
}
