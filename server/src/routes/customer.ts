import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/errors.js';
import { requireCustomer, signCustomerToken } from '../middleware/auth.js';
import { getBookingDetail, rescheduleBooking } from '../services/booking.js';
import { submitReview } from '../services/reviews.js';
import { getBalance } from '../services/loyalty.js';
import { wake } from '../services/notify/dispatcher.js';

export const customerRouter = Router();

// ---------------------------------------------------------------- auth
const signupSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  phone: z.string().max(30).optional(),
});

customerRouter.post('/auth/signup', asyncHandler(async (req, res) => {
  const input = signupSchema.parse(req.body);
  const { rows: [existing] } = await pool.query(
    'SELECT id, password_hash FROM customers WHERE email = lower($1)', [input.email.trim()]
  );
  if (existing?.password_hash) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  const hash = await bcrypt.hash(input.password, 10);
  // Upserting by email links any prior guest bookings to the new account.
  const { rows: [customer] } = await pool.query(
    `INSERT INTO customers (name, email, phone, password_hash)
     VALUES ($1, lower($2), $3, $4)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       name = EXCLUDED.name,
       phone = CASE WHEN EXCLUDED.phone <> '' THEN EXCLUDED.phone ELSE customers.phone END
     RETURNING *`,
    [input.name.trim(), input.email.trim(), input.phone?.trim() ?? '', hash]
  );
  const claims = { sub: customer.id, email: customer.email, name: customer.name };
  res.status(201).json({ token: signCustomerToken(claims), user: claims });
}));

customerRouter.post('/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = z
    .object({ email: z.string().email(), password: z.string().min(1) })
    .parse(req.body);
  const { rows: [customer] } = await pool.query(
    'SELECT * FROM customers WHERE email = lower($1)', [email.trim()]
  );
  if (!customer?.password_hash || !(await bcrypt.compare(password, customer.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const claims = { sub: customer.id, email: customer.email, name: customer.name };
  res.json({ token: signCustomerToken(claims), user: claims });
}));

// ------------------------------------------------------------ account (auth'd)
customerRouter.use(requireCustomer);

customerRouter.get('/me', asyncHandler(async (req, res) => {
  const { rows: [customer] } = await pool.query(
    'SELECT id, name, email, phone, created_at FROM customers WHERE id = $1', [req.customer!.sub]
  );
  if (!customer) return res.status(404).json({ error: 'Account not found' });
  res.json({ ...customer, points_balance: await getBalance(pool, customer.id) });
}));

customerRouter.get('/loyalty', asyncHandler(async (req, res) => {
  const [balance, ledger] = await Promise.all([
    getBalance(pool, req.customer!.sub),
    pool.query(
      `SELECT l.points, l.reason, l.detail, l.created_at, b.code AS booking_code
       FROM loyalty_ledger l
       LEFT JOIN bookings b ON b.id = l.booking_id
       WHERE l.customer_id = $1
       ORDER BY l.created_at DESC
       LIMIT 100`,
      [req.customer!.sub]
    ),
  ]);
  res.json({ balance, ledger: ledger.rows });
}));

customerRouter.patch('/me', asyncHandler(async (req, res) => {
  const input = z
    .object({ name: z.string().min(2).max(120), phone: z.string().max(30).default('') })
    .parse(req.body);
  const { rows: [customer] } = await pool.query(
    'UPDATE customers SET name = $2, phone = $3 WHERE id = $1 RETURNING id, name, email, phone, created_at',
    [req.customer!.sub, input.name.trim(), input.phone.trim()]
  );
  res.json(customer);
}));

customerRouter.get('/bookings', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*,
            c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            s.name AS service_name, s.duration_min,
            p.name AS provider_name, p.title AS provider_title, p.business_type, p.emoji, p.color,
            p.reschedule_cutoff_min,
            EXISTS(SELECT 1 FROM reviews r WHERE r.booking_id = b.id) AS reviewed
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN services  s ON s.id = b.service_id
     JOIN providers p ON p.id = b.provider_id
     WHERE b.customer_id = $1
     ORDER BY b.starts_at DESC`,
    [req.customer!.sub]
  );
  res.json(rows);
}));

// ----------------------------------------------------------------- favorites
customerRouter.get('/favorites', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*,
            COALESCE(json_agg(json_build_object(
              'id', s.id, 'name', s.name, 'description', s.description,
              'duration_min', s.duration_min, 'buffer_min', s.buffer_min, 'price_cents', s.price_cents
            ) ORDER BY s.price_cents) FILTER (WHERE s.id IS NOT NULL), '[]') AS services,
            (SELECT round(avg(rating), 1) FROM reviews WHERE provider_id = p.id AND NOT hidden) AS avg_rating,
            (SELECT count(*) FROM reviews WHERE provider_id = p.id AND NOT hidden)              AS review_count
     FROM favorites f
     JOIN providers p ON p.id = f.provider_id AND p.active
     LEFT JOIN services s ON s.provider_id = p.id AND s.active
     WHERE f.customer_id = $1
     GROUP BY p.id, f.created_at
     ORDER BY f.created_at DESC`,
    [req.customer!.sub]
  );
  res.json(rows);
}));

customerRouter.get('/favorites/ids', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT provider_id FROM favorites WHERE customer_id = $1', [req.customer!.sub]
  );
  res.json(rows.map((r) => r.provider_id));
}));

customerRouter.put('/favorites/:providerId', asyncHandler(async (req, res) => {
  const providerId = z.coerce.number().int().parse(req.params.providerId);
  const { rows: [provider] } = await pool.query(
    'SELECT id FROM providers WHERE id = $1 AND active', [providerId]
  );
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  await pool.query(
    'INSERT INTO favorites (customer_id, provider_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.customer!.sub, providerId]
  );
  res.json({ ok: true });
}));

customerRouter.delete('/favorites/:providerId', asyncHandler(async (req, res) => {
  const providerId = z.coerce.number().int().parse(req.params.providerId);
  await pool.query(
    'DELETE FROM favorites WHERE customer_id = $1 AND provider_id = $2', [req.customer!.sub, providerId]
  );
  res.json({ ok: true });
}));

customerRouter.post('/bookings/:id/review', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { rating, comment } = z.object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(2000).default(''),
  }).parse(req.body);
  const detail = await getBookingDetail('b.id = $1 AND b.customer_id = $2', [id, req.customer!.sub]);
  if (!detail) return res.status(404).json({ error: 'Booking not found' });
  const review = await submitReview(detail, rating, comment);
  if (!review) return res.status(409).json({ error: 'This booking has already been reviewed' });
  res.status(201).json(review);
}));

customerRouter.post('/bookings/:id/reschedule', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { start } = z.object({ start: z.string() }).parse(req.body);
  const { rows: [own] } = await pool.query(
    'SELECT id FROM bookings WHERE id = $1 AND customer_id = $2', [id, req.customer!.sub]
  );
  if (!own) return res.status(404).json({ error: 'Booking not found' });
  await rescheduleBooking(id, start, 'customer');
  wake();
  res.json(await getBookingDetail('b.id = $1', [id]));
}));
