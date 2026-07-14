import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/errors.js';
import { requireAdmin } from '../middleware/auth.js';
import { getBookingDetail } from '../services/booking.js';
import { sendCancellationEmail } from '../services/email.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// ---------------------------------------------------------------- dashboard
adminRouter.get('/stats', asyncHandler(async (_req, res) => {
  const { rows: [stats] } = await pool.query(`
    SELECT
      (SELECT count(*) FROM bookings WHERE starts_at::date = current_date AND status = 'confirmed')                    AS today_confirmed,
      (SELECT count(*) FROM bookings WHERE starts_at >= now() AND starts_at < now() + interval '7 days' AND status = 'confirmed') AS next7_confirmed,
      (SELECT coalesce(sum(price_cents), 0) FROM bookings WHERE status IN ('confirmed','completed') AND starts_at >= date_trunc('month', now())) AS month_revenue_cents,
      (SELECT count(*) FROM bookings WHERE status = 'cancelled' AND created_at >= now() - interval '30 days')          AS cancelled_30d,
      (SELECT count(*) FROM bookings WHERE created_at >= now() - interval '30 days')                                   AS created_30d,
      (SELECT count(*) FROM providers WHERE active)                                                                    AS active_providers,
      (SELECT count(*) FROM customers)                                                                                 AS customers
  `);
  const { rows: byProvider } = await pool.query(`
    SELECT p.id, p.name, p.emoji, p.color,
           count(b.id) FILTER (WHERE b.status = 'confirmed' AND b.starts_at >= now()) AS upcoming,
           coalesce(sum(b.price_cents) FILTER (WHERE b.status IN ('confirmed','completed')
                    AND b.starts_at >= date_trunc('month', now())), 0) AS month_revenue_cents
    FROM providers p
    LEFT JOIN bookings b ON b.provider_id = p.id
    WHERE p.active
    GROUP BY p.id ORDER BY upcoming DESC, p.name
  `);
  res.json({ ...stats, byProvider });
}));

// ---------------------------------------------------------------- bookings
adminRouter.get('/bookings', asyncHandler(async (req, res) => {
  const q = z.object({
    status: z.string().optional(),
    providerId: z.coerce.number().int().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    search: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }).parse(req.query);

  const params: unknown[] = [];
  const where: string[] = ['true'];
  if (q.status) { params.push(q.status); where.push(`b.status = $${params.length}`); }
  if (q.providerId) { params.push(q.providerId); where.push(`b.provider_id = $${params.length}`); }
  if (q.date) { params.push(q.date); where.push(`b.starts_at::date = $${params.length}::date`); }
  if (q.search) {
    params.push(`%${q.search}%`);
    where.push(`(b.code ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.email ILIKE $${params.length})`);
  }
  params.push(q.limit);

  const { rows } = await pool.query(
    `SELECT b.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            s.name AS service_name, p.name AS provider_name, p.emoji, p.color, p.business_type
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN services s ON s.id = b.service_id
     JOIN providers p ON p.id = b.provider_id
     WHERE ${where.join(' AND ')}
     ORDER BY b.starts_at DESC
     LIMIT $${params.length}`,
    params
  );
  res.json(rows);
}));

adminRouter.get('/bookings/:id/events', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { rows } = await pool.query(
    'SELECT * FROM booking_events WHERE booking_id = $1 ORDER BY created_at', [id]
  );
  res.json(rows);
}));

const TRANSITIONS: Record<string, string[]> = {
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
  await pool.query(`UPDATE bookings SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
  await pool.query(
    `INSERT INTO booking_events (booking_id, event, actor) VALUES ($1, $2, $3)`,
    [id, status, `admin:${req.admin!.email}`]
  );
  if (status === 'cancelled') sendCancellationEmail({ ...detail, status }, 'the provider');
  res.json({ ...detail, status });
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
    `INSERT INTO providers (business_type, name, title, bio, emoji, color, slot_step_min, min_lead_min, booking_horizon_days, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [p.business_type, p.name, p.title, p.bio, p.emoji, p.color, p.slot_step_min, p.min_lead_min, p.booking_horizon_days, p.active]
  );
  res.status(201).json(row);
}));

adminRouter.put('/providers/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const p = providerSchema.parse(req.body);
  const { rows: [row] } = await pool.query(
    `UPDATE providers SET business_type=$2, name=$3, title=$4, bio=$5, emoji=$6, color=$7,
       slot_step_min=$8, min_lead_min=$9, booking_horizon_days=$10, active=$11
     WHERE id = $1 RETURNING *`,
    [id, p.business_type, p.name, p.title, p.bio, p.emoji, p.color, p.slot_step_min, p.min_lead_min, p.booking_horizon_days, p.active]
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
  active: z.boolean().default(true),
});

adminRouter.post('/providers/:id/services', asyncHandler(async (req, res) => {
  const providerId = z.coerce.number().int().parse(req.params.id);
  const s = serviceSchema.parse(req.body);
  const { rows: [row] } = await pool.query(
    `INSERT INTO services (provider_id, name, description, duration_min, buffer_min, price_cents, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [providerId, s.name, s.description, s.duration_min, s.buffer_min, s.price_cents, s.active]
  );
  res.status(201).json(row);
}));

adminRouter.put('/services/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const s = serviceSchema.parse(req.body);
  const { rows: [row] } = await pool.query(
    `UPDATE services SET name=$2, description=$3, duration_min=$4, buffer_min=$5, price_cents=$6, active=$7
     WHERE id = $1 RETURNING *`,
    [id, s.name, s.description, s.duration_min, s.buffer_min, s.price_cents, s.active]
  );
  if (!row) return res.status(404).json({ error: 'Service not found' });
  res.json(row);
}));
