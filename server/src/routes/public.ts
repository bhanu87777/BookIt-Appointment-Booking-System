import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/errors.js';
import { signAdminToken } from '../middleware/auth.js';
import { computeSlots } from '../services/slots.js';
import { createBooking, getBookingDetail } from '../services/booking.js';
import { sendConfirmationEmail, sendCancellationEmail } from '../services/email.js';

export const publicRouter = Router();

// ---------------------------------------------------------------- auth
publicRouter.post('/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = z
    .object({ email: z.string().email(), password: z.string().min(1) })
    .parse(req.body);
  const { rows: [user] } = await pool.query('SELECT * FROM users WHERE email = lower($1)', [email]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const claims = { sub: user.id, email: user.email, name: user.name };
  res.json({ token: signAdminToken(claims), user: claims });
}));

// ---------------------------------------------------------------- catalog
export const BUSINESS_TYPES = [
  { key: 'doctor', label: 'Doctors & Clinics', emoji: '🩺', tagline: 'Consultations, follow-ups and procedures' },
  { key: 'salon', label: 'Salons & Grooming', emoji: '💇', tagline: 'Cuts, color, styling and self-care' },
  { key: 'turf', label: 'Turfs & Courts', emoji: '⚽', tagline: 'Football turfs, badminton courts and more' },
] as const;

publicRouter.get('/business-types', (_req, res) => res.json(BUSINESS_TYPES));

publicRouter.get('/providers', asyncHandler(async (req, res) => {
  const type = req.query.type as string | undefined;
  const params: unknown[] = [];
  let where = 'p.active';
  if (type) {
    params.push(type);
    where += ` AND p.business_type = $1`;
  }
  const { rows } = await pool.query(
    `SELECT p.*,
            COALESCE(json_agg(json_build_object(
              'id', s.id, 'name', s.name, 'description', s.description,
              'duration_min', s.duration_min, 'buffer_min', s.buffer_min, 'price_cents', s.price_cents
            ) ORDER BY s.price_cents) FILTER (WHERE s.id IS NOT NULL), '[]') AS services
     FROM providers p
     LEFT JOIN services s ON s.provider_id = p.id AND s.active
     WHERE ${where}
     GROUP BY p.id
     ORDER BY p.name`,
    params
  );
  res.json(rows);
}));

publicRouter.get('/providers/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { rows: [provider] } = await pool.query('SELECT * FROM providers WHERE id = $1 AND active', [id]);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  const [services, schedules] = await Promise.all([
    pool.query('SELECT * FROM services WHERE provider_id = $1 AND active ORDER BY price_cents', [id]),
    pool.query('SELECT weekday, start_time, end_time FROM schedules WHERE provider_id = $1 ORDER BY weekday, start_time', [id]),
  ]);
  res.json({ ...provider, services: services.rows, schedules: schedules.rows });
}));

// ---------------------------------------------------------------- slots
publicRouter.get('/providers/:id/slots', asyncHandler(async (req, res) => {
  const providerId = z.coerce.number().int().parse(req.params.id);
  const { serviceId, date } = z.object({
    serviceId: z.coerce.number().int(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).parse(req.query);
  const { slots } = await computeSlots(pool, providerId, serviceId, date);
  res.json({ date, slots });
}));

// ---------------------------------------------------------------- bookings
const bookingSchema = z.object({
  providerId: z.number().int(),
  serviceId: z.number().int(),
  start: z.string(),
  customer: z.object({
    name: z.string().min(2).max(120),
    email: z.string().email(),
    phone: z.string().max(30).optional(),
  }),
  notes: z.string().max(1000).optional(),
});

publicRouter.post('/bookings', asyncHandler(async (req, res) => {
  const input = bookingSchema.parse(req.body);
  const { booking } = await createBooking(input);
  const detail = await getBookingDetail('b.id = $1', [booking.id]);
  sendConfirmationEmail(detail); // fire-and-forget; failures are logged
  res.status(201).json(detail);
}));

publicRouter.get('/bookings/lookup', asyncHandler(async (req, res) => {
  const { code, email } = z
    .object({ code: z.string().min(4), email: z.string().email() })
    .parse(req.query);
  const detail = await getBookingDetail(
    'upper(b.code) = upper($1) AND c.email = lower($2)', [code.trim(), email.trim()]
  );
  if (!detail) return res.status(404).json({ error: 'No booking found for that code and email' });
  res.json(detail);
}));

publicRouter.post('/bookings/:code/cancel', asyncHandler(async (req, res) => {
  const code = z.string().parse(req.params.code);
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const detail = await getBookingDetail(
    'upper(b.code) = upper($1) AND c.email = lower($2)', [code.trim(), email.trim()]
  );
  if (!detail) return res.status(404).json({ error: 'No booking found for that code and email' });
  if (detail.status !== 'confirmed') {
    return res.status(400).json({ error: `This booking is already ${detail.status}` });
  }
  if (new Date(detail.starts_at) < new Date()) {
    return res.status(400).json({ error: 'Past bookings cannot be cancelled' });
  }
  await pool.query(
    `UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = $1`, [detail.id]
  );
  await pool.query(
    `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1,'cancelled','customer','Cancelled via manage page')`,
    [detail.id]
  );
  sendCancellationEmail({ ...detail, status: 'cancelled' }, 'you');
  res.json({ ...detail, status: 'cancelled' });
}));
