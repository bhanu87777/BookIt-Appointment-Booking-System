import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/errors.js';
import { requireAdmin } from '../middleware/auth.js';
import { cancelBooking, getBookingDetail } from '../services/booking.js';
import { wake } from '../services/notify/dispatcher.js';
import { executeRefund, refundedSoFar } from '../services/refunds.js';
import { earnForCompletion } from '../services/loyalty.js';

import { analyticsRouter } from './adminAnalytics.js';
import { adminCustomersRouter } from './adminCustomers.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);
adminRouter.use(analyticsRouter);
adminRouter.use(adminCustomersRouter);

// ---------------------------------------------------------------- dashboard
adminRouter.get('/stats', asyncHandler(async (_req, res) => {
  const { rows: [stats] } = await pool.query(`
    SELECT
      (SELECT count(*) FROM bookings WHERE starts_at::date = current_date AND status = 'confirmed')                    AS today_confirmed,
      (SELECT count(*) FROM bookings WHERE starts_at >= now() AND starts_at < now() + interval '7 days' AND status = 'confirmed') AS next7_confirmed,
      (SELECT coalesce(sum(price_cents - discount_cents), 0) FROM bookings WHERE status IN ('confirmed','completed') AND starts_at >= date_trunc('month', now())) AS month_revenue_cents,
      (SELECT coalesce(sum(p.amount_cents), 0) FROM payments p WHERE p.status IN ('captured','partially_refunded','refunded') AND p.updated_at >= date_trunc('month', now())) AS month_collected_cents,
      (SELECT coalesce(sum(r.amount_cents), 0) FROM refunds r WHERE r.status <> 'failed' AND r.created_at >= date_trunc('month', now())) AS month_refunded_cents,
      (SELECT count(*) FROM bookings WHERE status = 'cancelled' AND created_at >= now() - interval '30 days')          AS cancelled_30d,
      (SELECT count(*) FROM bookings WHERE created_at >= now() - interval '30 days')                                   AS created_30d,
      (SELECT count(*) FROM providers WHERE active)                                                                    AS active_providers,
      (SELECT count(*) FROM customers)                                                                                 AS customers
  `);
  const { rows: byProvider } = await pool.query(`
    SELECT p.id, p.name, p.emoji, p.color,
           count(b.id) FILTER (WHERE b.status = 'confirmed' AND b.starts_at >= now()) AS upcoming,
           coalesce(sum(b.price_cents - b.discount_cents) FILTER (WHERE b.status IN ('confirmed','completed')
                    AND b.starts_at >= date_trunc('month', now())), 0) AS month_revenue_cents
    FROM providers p
    LEFT JOIN bookings b ON b.provider_id = p.id
    WHERE p.active
    GROUP BY p.id ORDER BY upcoming DESC, p.name
  `);
  res.json({ ...stats, byProvider });
}));

// ---------------------------------------------------------------- bookings
const bookingFilterSchema = z.object({
  status: z.string().optional(),
  providerId: z.coerce.number().int().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().optional(),
});

/** Shared by the list endpoint and the CSV export so they always agree. */
function buildBookingFilter(q: z.infer<typeof bookingFilterSchema>) {
  const params: unknown[] = [];
  const where: string[] = ['true'];
  if (q.status) { params.push(q.status); where.push(`b.status = $${params.length}`); }
  if (q.providerId) { params.push(q.providerId); where.push(`b.provider_id = $${params.length}`); }
  if (q.date) { params.push(q.date); where.push(`b.starts_at::date = $${params.length}::date`); }
  if (q.search) {
    params.push(`%${q.search}%`);
    where.push(`(b.code ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.email ILIKE $${params.length})`);
  }
  return { params, where: where.join(' AND ') };
}

const BOOKING_LIST_SELECT = `
  SELECT b.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
         s.name AS service_name, p.name AS provider_name, p.emoji, p.color, p.business_type
  FROM bookings b
  JOIN customers c ON c.id = b.customer_id
  JOIN services s ON s.id = b.service_id
  JOIN providers p ON p.id = b.provider_id`;

adminRouter.get('/bookings', asyncHandler(async (req, res) => {
  const q = bookingFilterSchema.extend({
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }).parse(req.query);
  const { params, where } = buildBookingFilter(q);
  params.push(q.limit);
  const { rows } = await pool.query(
    `${BOOKING_LIST_SELECT} WHERE ${where} ORDER BY b.starts_at DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows);
}));

/** CSV cell: quote when needed, double inner quotes, defuse formula injection. */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

adminRouter.get('/bookings.csv', asyncHandler(async (req, res) => {
  const q = bookingFilterSchema.parse(req.query);
  const { params, where } = buildBookingFilter(q);
  const { rows } = await pool.query(
    `${BOOKING_LIST_SELECT} WHERE ${where} ORDER BY b.starts_at DESC LIMIT 10000`,
    params
  );
  const header = ['code', 'status', 'provider', 'service', 'customer_name', 'customer_email',
    'customer_phone', 'starts_at', 'ends_at', 'price_inr', 'discount_inr', 'paid_online_inr',
    'coupon', 'created_at', 'notes'];
  const lines = [header.join(',')];
  for (const b of rows) {
    lines.push([
      b.code, b.status, b.provider_name, b.service_name, b.customer_name, b.customer_email,
      b.customer_phone,
      new Date(b.starts_at).toISOString(), new Date(b.ends_at).toISOString(),
      (b.price_cents / 100).toFixed(2), (b.discount_cents / 100).toFixed(2),
      (b.amount_due_cents / 100).toFixed(2), b.coupon_code ?? '',
      new Date(b.created_at).toISOString(), b.notes,
    ].map(csvCell).join(','));
  }
  // BOM so Excel opens UTF-8 (₹, emoji) correctly; CRLF per RFC 4180
  const csv = '﻿' + lines.join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bookings-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

adminRouter.get('/bookings/:id/events', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { rows } = await pool.query(
    'SELECT * FROM booking_events WHERE booking_id = $1 ORDER BY created_at', [id]
  );
  res.json(rows);
}));

const TRANSITIONS: Record<string, string[]> = {
  pending_payment: ['cancelled'], // cancelling an unpaid hold releases the slot
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
};

adminRouter.patch('/bookings/:id/status', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { status } = z.object({ status: z.enum(['completed', 'cancelled', 'no_show']) }).parse(req.body);

  const detail = await getBookingDetail('b.id = $1', [id]);
  if (!detail) return res.status(404).json({ error: 'Booking not found' });
  if (!TRANSITIONS[detail.status]?.includes(status)) {
    return res.status(400).json({ error: `Cannot move a ${detail.status} booking to ${status}` });
  }
  if (status === 'cancelled') {
    // provider-initiated cancellations never penalize the customer
    await cancelBooking(id, `admin:${req.admin!.email}`, { cancelledBy: 'the provider', refund: 'full' });
    wake();
  } else {
    await pool.query(`UPDATE bookings SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
    await pool.query(
      `INSERT INTO booking_events (booking_id, event, actor) VALUES ($1, $2, $3)`,
      [id, status, `admin:${req.admin!.email}`]
    );
    if (status === 'completed') await earnForCompletion(detail);
  }
  res.json({ ...detail, status });
}));

// ------------------------------------------------------------------ payments
adminRouter.get('/payments', asyncHandler(async (req, res) => {
  const q = z.object({
    status: z.string().optional(),
    search: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }).parse(req.query);
  const params: unknown[] = [];
  const where: string[] = ['true'];
  if (q.status) { params.push(q.status); where.push(`p.status = $${params.length}`); }
  if (q.search) {
    params.push(`%${q.search}%`);
    where.push(`(b.code ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.email ILIKE $${params.length} OR p.order_id ILIKE $${params.length})`);
  }
  params.push(q.limit);
  const { rows } = await pool.query(
    `SELECT p.*, b.code AS booking_code, b.starts_at, b.status AS booking_status,
            c.name AS customer_name, c.email AS customer_email,
            pr.name AS provider_name, pr.emoji, s.name AS service_name,
            (SELECT coalesce(sum(r.amount_cents), 0)::int FROM refunds r
             WHERE r.payment_id = p.id AND r.status <> 'failed') AS refunded_cents
     FROM payments p
     JOIN bookings b ON b.id = p.booking_id
     JOIN customers c ON c.id = b.customer_id
     JOIN providers pr ON pr.id = b.provider_id
     JOIN services s ON s.id = b.service_id
     WHERE ${where.join(' AND ')}
     ORDER BY p.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  res.json(rows);
}));

adminRouter.post('/payments/:id/refund', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { amountCents } = z.object({ amountCents: z.number().int().positive().optional() }).parse(req.body);
  const { rows: [payment] } = await pool.query(
    `SELECT * FROM payments WHERE id = $1 AND status IN ('captured', 'partially_refunded')`, [id]
  );
  if (!payment) return res.status(404).json({ error: 'No refundable payment found' });
  const refundable = payment.amount_cents - (await refundedSoFar(payment.id));
  if (refundable <= 0) return res.status(400).json({ error: 'This payment is already fully refunded' });
  const result = await executeRefund(
    payment,
    amountCents ?? refundable,
    'admin_manual',
    `admin:${req.admin!.email}`
  );
  res.json(result);
}));

// ------------------------------------------------------------------ waitlist
adminRouter.get('/waitlist', asyncHandler(async (req, res) => {
  const q = z.object({
    providerId: z.coerce.number().int().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    status: z.enum(['waiting', 'notified', 'converted', 'expired']).optional(),
  }).parse(req.query);
  const params: unknown[] = [];
  const where: string[] = ['true'];
  if (q.providerId) { params.push(q.providerId); where.push(`w.provider_id = $${params.length}`); }
  if (q.date) { params.push(q.date); where.push(`w.date = $${params.length}::date`); }
  if (q.status) { params.push(q.status); where.push(`w.status = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT w.*, p.name AS provider_name, p.emoji, s.name AS service_name
     FROM waitlist w
     JOIN providers p ON p.id = w.provider_id
     JOIN services s ON s.id = w.service_id
     WHERE ${where.join(' AND ')}
     ORDER BY w.date, w.created_at
     LIMIT 300`,
    params
  );
  res.json(rows);
}));

adminRouter.delete('/waitlist/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  // soft-remove keeps the audit trail
  await pool.query(`UPDATE waitlist SET status = 'expired' WHERE id = $1`, [id]);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------- coupons
const couponSchema = z.object({
  code: z.string().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/).transform((s) => s.toUpperCase()),
  type: z.enum(['percent', 'fixed']),
  value: z.number().int().positive(),
  max_uses: z.number().int().positive().nullable().default(null),
  min_amount_cents: z.number().int().min(0).default(0),
  valid_from: z.string().nullable().default(null),
  valid_to: z.string().nullable().default(null),
  active: z.boolean().default(true),
}).refine((c) => c.type !== 'percent' || c.value <= 100, { message: 'Percent value must be ≤ 100' });

adminRouter.get('/coupons', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
  res.json(rows);
}));

adminRouter.post('/coupons', asyncHandler(async (req, res) => {
  const c = couponSchema.parse(req.body);
  try {
    const { rows: [row] } = await pool.query(
      `INSERT INTO coupons (code, type, value, max_uses, min_amount_cents, valid_from, valid_to, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [c.code, c.type, c.value, c.max_uses, c.min_amount_cents, c.valid_from, c.valid_to, c.active]
    );
    res.status(201).json(row);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'A coupon with this code already exists' });
    throw err;
  }
}));

adminRouter.put('/coupons/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const c = couponSchema.parse(req.body);
  const { rows: [row] } = await pool.query(
    `UPDATE coupons SET code=$2, type=$3, value=$4, max_uses=$5, min_amount_cents=$6,
       valid_from=$7, valid_to=$8, active=$9
     WHERE id = $1 RETURNING *`,
    [id, c.code, c.type, c.value, c.max_uses, c.min_amount_cents, c.valid_from, c.valid_to, c.active]
  );
  if (!row) return res.status(404).json({ error: 'Coupon not found' });
  res.json(row);
}));

// ------------------------------------------------------------------- reviews
adminRouter.get('/reviews', asyncHandler(async (req, res) => {
  const q = z.object({
    providerId: z.coerce.number().int().optional(),
    hidden: z.enum(['true', 'false']).optional(),
  }).parse(req.query);
  const params: unknown[] = [];
  const where: string[] = ['true'];
  if (q.providerId) { params.push(q.providerId); where.push(`r.provider_id = $${params.length}`); }
  if (q.hidden) { params.push(q.hidden === 'true'); where.push(`r.hidden = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT r.*, b.code AS booking_code, c.name AS customer_name, c.email AS customer_email,
            p.name AS provider_name, p.emoji, s.name AS service_name
     FROM reviews r
     JOIN bookings b ON b.id = r.booking_id
     JOIN customers c ON c.id = r.customer_id
     JOIN providers p ON p.id = r.provider_id
     JOIN services s ON s.id = b.service_id
     WHERE ${where.join(' AND ')}
     ORDER BY r.created_at DESC
     LIMIT 200`,
    params
  );
  res.json(rows);
}));

adminRouter.patch('/reviews/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);
  const { rows: [row] } = await pool.query(
    'UPDATE reviews SET hidden = $2 WHERE id = $1 RETURNING *', [id, hidden]
  );
  if (!row) return res.status(404).json({ error: 'Review not found' });
  await pool.query(
    `INSERT INTO booking_events (booking_id, event, actor) VALUES ($1, $2, $3)`,
    [row.booking_id, hidden ? 'review_hidden' : 'review_unhidden', `admin:${req.admin!.email}`]
  );
  res.json(row);
}));

// ------------------------------------------------------- day view (timeline)
adminRouter.get('/day', asyncHandler(async (req, res) => {
  const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT b.id, b.code, b.starts_at, b.ends_at, b.status, b.provider_id,
            c.name AS customer_name, s.name AS service_name
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN services s ON s.id = b.service_id
     WHERE b.starts_at::date = $1::date AND b.status IN ('confirmed','completed')
     ORDER BY b.starts_at`,
    [date]
  );
  res.json(rows);
}));

// ------------------------------------------------------- week view (calendar)
adminRouter.get('/week', asyncHandler(async (req, res) => {
  const q = z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    providerId: z.coerce.number().int().optional(),
  }).parse(req.query);
  const params: unknown[] = [q.start];
  let where = `b.starts_at >= $1::date AND b.starts_at < $1::date + interval '7 days'
               AND b.status IN ('pending_payment','confirmed','completed')`;
  if (q.providerId) {
    params.push(q.providerId);
    where += ` AND b.provider_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT b.id, b.code, b.starts_at, b.ends_at, b.status, b.provider_id,
            c.name AS customer_name, s.name AS service_name, s.duration_min,
            p.name AS provider_name, p.color, p.emoji
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN services s ON s.id = b.service_id
     JOIN providers p ON p.id = b.provider_id
     WHERE ${where}
     ORDER BY b.starts_at`,
    params
  );
  res.json(rows);
}));

// ---------------------------------------------------------------- providers
const providerSchema = z.object({
  business_type: z.enum(['doctor', 'salon', 'turf']),
  name: z.string().min(2).max(120),
  title: z.string().max(120).default(''),
  bio: z.string().max(2000).default(''),
  emoji: z.string().max(8).default('📅'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  slot_step_min: z.number().int().min(5).max(120).default(15),
  min_lead_min: z.number().int().min(0).max(10080).default(60),
  booking_horizon_days: z.number().int().min(1).max(365).default(30),
  reschedule_cutoff_min: z.number().int().min(0).max(10080).default(120),
  active: z.boolean().default(true),
});

adminRouter.get('/providers', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT p.*, count(s.id) FILTER (WHERE s.active) AS service_count
    FROM providers p LEFT JOIN services s ON s.provider_id = p.id
    GROUP BY p.id ORDER BY p.business_type, p.name
  `);
  res.json(rows);
}));

adminRouter.get('/providers/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { rows: [provider] } = await pool.query('SELECT * FROM providers WHERE id = $1', [id]);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  const [services, schedules, breaks, timeOff] = await Promise.all([
    pool.query('SELECT * FROM services WHERE provider_id = $1 ORDER BY active DESC, name', [id]),
    pool.query('SELECT * FROM schedules WHERE provider_id = $1 ORDER BY weekday, start_time', [id]),
    pool.query('SELECT * FROM breaks WHERE provider_id = $1 ORDER BY weekday, start_time', [id]),
    pool.query('SELECT * FROM time_off WHERE provider_id = $1 AND ends_at > now() ORDER BY starts_at', [id]),
  ]);
  res.json({
    ...provider,
    services: services.rows,
    schedules: schedules.rows,
    breaks: breaks.rows,
    time_off: timeOff.rows,
  });
}));

adminRouter.post('/providers', asyncHandler(async (req, res) => {
  const p = providerSchema.parse(req.body);
  const { rows: [row] } = await pool.query(
    `INSERT INTO providers (business_type, name, title, bio, emoji, color, slot_step_min, min_lead_min, booking_horizon_days, reschedule_cutoff_min, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [p.business_type, p.name, p.title, p.bio, p.emoji, p.color, p.slot_step_min, p.min_lead_min, p.booking_horizon_days, p.reschedule_cutoff_min, p.active]
  );
  res.status(201).json(row);
}));

adminRouter.put('/providers/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const p = providerSchema.parse(req.body);
  const { rows: [row] } = await pool.query(
    `UPDATE providers SET business_type=$2, name=$3, title=$4, bio=$5, emoji=$6, color=$7,
       slot_step_min=$8, min_lead_min=$9, booking_horizon_days=$10, reschedule_cutoff_min=$11, active=$12
     WHERE id = $1 RETURNING *`,
    [id, p.business_type, p.name, p.title, p.bio, p.emoji, p.color, p.slot_step_min, p.min_lead_min, p.booking_horizon_days, p.reschedule_cutoff_min, p.active]
  );
  if (!row) return res.status(404).json({ error: 'Provider not found' });
  res.json(row);
}));

// Replace the full weekly schedule + breaks atomically
adminRouter.put('/providers/:id/schedule', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const timeRe = /^\d{2}:\d{2}(:\d{2})?$/;
  const body = z.object({
    schedules: z.array(z.object({
      weekday: z.number().int().min(0).max(6),
      start_time: z.string().regex(timeRe),
      end_time: z.string().regex(timeRe),
    })),
    breaks: z.array(z.object({
      weekday: z.number().int().min(0).max(6),
      start_time: z.string().regex(timeRe),
      end_time: z.string().regex(timeRe),
      label: z.string().max(80).default('Break'),
    })),
  }).parse(req.body);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM schedules WHERE provider_id = $1', [id]);
    await client.query('DELETE FROM breaks WHERE provider_id = $1', [id]);
    for (const s of body.schedules) {
      await client.query(
        'INSERT INTO schedules (provider_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)',
        [id, s.weekday, s.start_time, s.end_time]
      );
    }
    for (const b of body.breaks) {
      await client.query(
        'INSERT INTO breaks (provider_id, weekday, start_time, end_time, label) VALUES ($1,$2,$3,$4,$5)',
        [id, b.weekday, b.start_time, b.end_time, b.label]
      );
    }
    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err.code === '23P01') {
      return res.status(400).json({ error: 'Working windows on the same day must not overlap' });
    }
    if (err.code === '23514') {
      return res.status(400).json({ error: 'Start time must be before end time' });
    }
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- time off
adminRouter.post('/providers/:id/time-off', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const body = z.object({
    starts_at: z.string(),
    ends_at: z.string(),
    reason: z.string().max(200).default(''),
  }).parse(req.body);
  if (new Date(body.starts_at) >= new Date(body.ends_at)) {
    return res.status(400).json({ error: 'Start must be before end' });
  }
  const { rows: [row] } = await pool.query(
    'INSERT INTO time_off (provider_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4) RETURNING *',
    [id, body.starts_at, body.ends_at, body.reason]
  );
  res.status(201).json(row);
}));

adminRouter.delete('/time-off/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  await pool.query('DELETE FROM time_off WHERE id = $1', [id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- services
const serviceSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(1000).default(''),
  duration_min: z.number().int().min(5).max(480),
  buffer_min: z.number().int().min(0).max(120).default(0),
  price_cents: z.number().int().min(0),
  payment_policy: z.enum(['none', 'deposit', 'full']).default('none'),
  deposit_pct: z.number().int().min(1).max(100).default(50),
  active: z.boolean().default(true),
});

adminRouter.post('/providers/:id/services', asyncHandler(async (req, res) => {
  const providerId = z.coerce.number().int().parse(req.params.id);
  const s = serviceSchema.parse(req.body);
  const { rows: [row] } = await pool.query(
    `INSERT INTO services (provider_id, name, description, duration_min, buffer_min, price_cents, payment_policy, deposit_pct, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [providerId, s.name, s.description, s.duration_min, s.buffer_min, s.price_cents, s.payment_policy, s.deposit_pct, s.active]
  );
  res.status(201).json(row);
}));

adminRouter.put('/services/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const s = serviceSchema.parse(req.body);
  const { rows: [row] } = await pool.query(
    `UPDATE services SET name=$2, description=$3, duration_min=$4, buffer_min=$5, price_cents=$6,
       payment_policy=$7, deposit_pct=$8, active=$9
     WHERE id = $1 RETURNING *`,
    [id, s.name, s.description, s.duration_min, s.buffer_min, s.price_cents, s.payment_policy, s.deposit_pct, s.active]
  );
  if (!row) return res.status(404).json({ error: 'Service not found' });
  res.json(row);
}));
