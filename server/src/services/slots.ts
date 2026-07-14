import type pg from 'pg';

export interface Slot {
  start: string; // ISO
  end: string;   // ISO
}

export interface Interval {
  start: Date;
  end: Date;
}

const MIN = 60000;

const overlaps = (aStart: Date, aEnd: Date, b: Interval) => aStart < b.end && aEnd > b.start;

/** "09:30:00" on `date` (local server time) -> Date */
function timeOnDate(date: string, time: string): Date {
  const [h, m, s] = time.split(':').map(Number);
  const d = new Date(`${date}T00:00:00`);
  d.setHours(h, m, s ?? 0, 0);
  return d;
}

/**
 * Compute bookable slots for a provider + service on a given date.
 *
 * Algorithm:
 *  1. Take the provider's working windows for that weekday.
 *  2. Walk each window in `slot_step_min` increments.
 *  3. A candidate [t, t + duration) is kept only if, after padding it with the
 *     service's buffer on both sides, it doesn't touch a break, time-off
 *     period, or an existing active booking — and it respects the minimum
 *     lead time and booking horizon.
 *
 * Runs against any pg client, so the booking transaction can re-validate a
 * requested slot with the exact same logic while holding the provider lock.
 */
export async function computeSlots(
  db: pg.Pool | pg.PoolClient,
  providerId: number,
  serviceId: number,
  date: string // YYYY-MM-DD
): Promise<{ slots: Slot[]; provider: any; service: any }> {
  const { rows: [provider] } = await db.query(
    'SELECT * FROM providers WHERE id = $1 AND active', [providerId]
  );
  if (!provider) throw Object.assign(new Error('Provider not found'), { status: 404 });

  const { rows: [service] } = await db.query(
    'SELECT * FROM services WHERE id = $1 AND provider_id = $2 AND active', [serviceId, providerId]
  );
  if (!service) throw Object.assign(new Error('Service not found'), { status: 404 });

  const dayStart = new Date(`${date}T00:00:00`);
  if (isNaN(dayStart.getTime())) throw Object.assign(new Error('Invalid date'), { status: 400 });
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * MIN);
  const weekday = dayStart.getDay();

  const now = new Date();
  const earliestStart = new Date(now.getTime() + provider.min_lead_min * MIN);
  const horizonEnd = new Date(now.getTime() + provider.booking_horizon_days * 24 * 60 * MIN);
  if (dayStart > horizonEnd) return { slots: [], provider, service };

  const [windows, breaks, timeOff, bookings] = await Promise.all([
    db.query(
      'SELECT start_time, end_time FROM schedules WHERE provider_id = $1 AND weekday = $2 ORDER BY start_time',
      [providerId, weekday]
    ),
    db.query(
      'SELECT start_time, end_time FROM breaks WHERE provider_id = $1 AND weekday = $2',
      [providerId, weekday]
    ),
    db.query(
      'SELECT starts_at, ends_at FROM time_off WHERE provider_id = $1 AND starts_at < $3 AND ends_at > $2',
      [providerId, dayStart, dayEnd]
    ),
    db.query(
      `SELECT starts_at, ends_at FROM bookings
       WHERE provider_id = $1 AND status IN ('confirmed','completed')
         AND starts_at < $3 AND ends_at > $2`,
      [providerId, dayStart, dayEnd]
    ),
  ]);

  const blocked: Interval[] = [
    ...breaks.rows.map((b) => ({
      start: timeOnDate(date, b.start_time),
      end: timeOnDate(date, b.end_time),
    })),
    ...timeOff.rows.map((t) => ({ start: new Date(t.starts_at), end: new Date(t.ends_at) })),
    ...bookings.rows.map((b) => ({ start: new Date(b.starts_at), end: new Date(b.ends_at) })),
  ];

  const step = provider.slot_step_min * MIN;
  const duration = service.duration_min * MIN;
  const buffer = service.buffer_min * MIN;
  const slots: Slot[] = [];

  for (const w of windows.rows) {
    const winStart = timeOnDate(date, w.start_time);
    const winEnd = timeOnDate(date, w.end_time);
    for (let t = winStart.getTime(); t + duration <= winEnd.getTime(); t += step) {
      const start = new Date(t);
      const end = new Date(t + duration);
      if (start < earliestStart) continue;
      if (start > horizonEnd) break;
      // pad with buffer so back-to-back bookings keep the prep/cleanup gap
      const padStart = new Date(t - buffer);
      const padEnd = new Date(t + duration + buffer);
      if (blocked.some((b) => overlaps(padStart, padEnd, b))) continue;
      slots.push({ start: start.toISOString(), end: end.toISOString() });
    }
  }

  return { slots, provider, service };
}
