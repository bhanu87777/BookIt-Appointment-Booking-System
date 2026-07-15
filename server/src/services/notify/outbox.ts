import type pg from 'pg';
import type { ChannelKey, Template } from './types.js';

type Db = pg.Pool | pg.PoolClient;

export interface EnqueueInput {
  bookingId?: number;
  waitlistId?: number;
  channel?: ChannelKey;
  template: Template;
  recipient: string;
  scheduledFor?: Date;
  payload?: Record<string, unknown>;
}

/**
 * Queue a notification. Accepts a PoolClient so callers can enqueue inside
 * their own transaction (a reminder exists iff its booking committed).
 * Duplicate reminders are absorbed by the partial unique index.
 */
export async function enqueue(db: Db, n: EnqueueInput): Promise<void> {
  await db.query(
    `INSERT INTO notifications (booking_id, waitlist_id, channel, template, recipient, scheduled_for, next_attempt_at, payload)
     VALUES ($1, $2, $3, $4, $5, coalesce($6, now()), coalesce($6, now()), $7)
     ON CONFLICT DO NOTHING`,
    [
      n.bookingId ?? null,
      n.waitlistId ?? null,
      n.channel ?? 'email',
      n.template,
      n.recipient,
      n.scheduledFor ?? null,
      JSON.stringify(n.payload ?? {}),
    ]
  );
}

/**
 * Confirmation now + reminders at start−24h / start−1h (only those still in
 * the future). Series bookings suppress the per-occurrence confirmation.
 */
export async function enqueueBookingLifecycle(
  db: Db,
  booking: { id: number; startsAt: string | Date; recipient: string },
  opts: { confirmation?: boolean } = {}
): Promise<void> {
  if (opts.confirmation !== false) {
    await enqueue(db, { bookingId: booking.id, template: 'confirmation', recipient: booking.recipient });
  }
  await enqueueReminders(db, booking);
}

export async function enqueueReminders(
  db: Db,
  booking: { id: number; startsAt: string | Date; recipient: string }
): Promise<void> {
  const starts = new Date(booking.startsAt);
  const now = new Date();
  const r24 = new Date(starts.getTime() - 24 * 3600_000);
  const r1 = new Date(starts.getTime() - 3600_000);
  if (r24 > now) {
    await enqueue(db, { bookingId: booking.id, template: 'reminder_24h', recipient: booking.recipient, scheduledFor: r24 });
  }
  if (r1 > now) {
    await enqueue(db, { bookingId: booking.id, template: 'reminder_1h', recipient: booking.recipient, scheduledFor: r1 });
  }
}

/**
 * Void reminders so they never fire (cancellation) or can be re-enqueued at
 * new times (reschedule — pass includeSent so the unique index frees up).
 */
export async function voidReminders(db: Db, bookingId: number, opts: { includeSent?: boolean } = {}): Promise<void> {
  const statuses = opts.includeSent ? ['pending', 'sent'] : ['pending'];
  await db.query(
    `UPDATE notifications SET status = 'void'
     WHERE booking_id = $1 AND template IN ('reminder_24h', 'reminder_1h') AND status = ANY($2)`,
    [bookingId, statuses]
  );
}
