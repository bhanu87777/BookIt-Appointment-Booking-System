import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/errors.js';
import { optionalCustomer, signAdminToken } from '../middleware/auth.js';
import { computeSlots } from '../services/slots.js';
import { cancelBooking, createBooking, getBookingDetail, rescheduleBooking } from '../services/booking.js';
import { submitReview } from '../services/reviews.js';
import { wake } from '../services/notify/dispatcher.js';
import { computeDiscount, validateCoupon } from '../services/coupons.js';
import { joinWaitlist } from '../services/waitlist.js';
import { cancelSeries, createSeries } from '../services/series.js';
import { computeRefundCents, refundedSoFar } from '../services/refunds.js';
import { paymentProvider } from '../services/payments/index.js';

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
            ) ORDER BY s.price_cents) FILTER (WHERE s.id IS NOT NULL), '[]') AS services,
            (SELECT round(avg(rating), 1) FROM reviews WHERE provider_id = p.id AND NOT hidden) AS avg_rating,
            (SELECT count(*) FROM reviews WHERE provider_id = p.id AND NOT hidden)              AS review_count
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
  const { rows: [provider] } = await pool.query(
    `SELECT p.*,
            (SELECT round(avg(rating), 1) FROM reviews WHERE provider_id = p.id AND NOT hidden) AS avg_rating,
            (SELECT count(*) FROM reviews WHERE provider_id = p.id AND NOT hidden)              AS review_count
     FROM providers p WHERE p.id = $1 AND p.active`,
    [id]
  );
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  const [services, schedules] = await Promise.all([
    pool.query('SELECT * FROM services WHERE provider_id = $1 AND active ORDER BY price_cents', [id]),
    pool.query('SELECT weekday, start_time, end_time FROM schedules WHERE provider_id = $1 ORDER BY weekday, start_time', [id]),
  ]);
  res.json({ ...provider, services: services.rows, schedules: schedules.rows });
}));

publicRouter.get('/providers/:id/reviews', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { rows } = await pool.query(
    `SELECT r.rating, r.comment, r.created_at,
            split_part(c.name, ' ', 1) AS customer_name, s.name AS service_name
     FROM reviews r
     JOIN bookings b ON b.id = r.booking_id
     JOIN customers c ON c.id = r.customer_id
     JOIN services s ON s.id = b.service_id
     WHERE r.provider_id = $1 AND NOT r.hidden
     ORDER BY r.created_at DESC
     LIMIT 50`,
    [id]
  );
  res.json(rows);
}));

// ---------------------------------------------------------------- slots
publicRouter.get('/providers/:id/slots', asyncHandler(async (req, res) => {
  const providerId = z.coerce.number().int().parse(req.params.id);
  const { serviceId, date, excludeBooking } = z.object({
    serviceId: z.coerce.number().int(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    excludeBooking: z.coerce.number().int().optional(), // reschedule: free the booking's own slot
  }).parse(req.query);
  const { slots } = await computeSlots(pool, providerId, serviceId, date, excludeBooking);
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
  couponCode: z.string().max(40).optional(),
  redeemPoints: z.number().int().min(1).optional(),
});

publicRouter.post('/bookings', optionalCustomer, asyncHandler(async (req, res) => {
  const input = bookingSchema.parse(req.body);
  if (input.redeemPoints && !req.customer) {
    return res.status(401).json({ error: 'Sign in to redeem points' });
  }
  const { booking, payment } = await createBooking({ ...input, customerAuthId: req.customer?.sub });
  const detail = await getBookingDetail('b.id = $1', [booking.id]);
  wake(); // confirmation email was queued in the booking txn — deliver it now
  res.status(201).json({
    ...detail,
    payment: payment
      ? {
          required: true,
          orderId: payment.order_id,
          amountCents: payment.amount_cents,
          currency: payment.currency,
          expiresAt: booking.expires_at,
          ...paymentProvider.checkoutPublicConfig(),
        }
      : null,
  });
}));

// ---------------------------------------------------------- recurring series
publicRouter.post('/bookings/series', asyncHandler(async (req, res) => {
  const input = z.object({
    providerId: z.number().int(),
    serviceId: z.number().int(),
    start: z.string(),
    customer: z.object({
      name: z.string().min(2).max(120),
      email: z.string().email(),
      phone: z.string().max(30).optional(),
    }),
    notes: z.string().max(1000).optional(),
    frequency: z.enum(['weekly', 'biweekly']),
    occurrences: z.number().int().min(2).max(12),
  }).parse(req.body);
  const result = await createSeries(input);
  wake();
  res.status(201).json(result);
}));

publicRouter.post('/bookings/series/:code/cancel', asyncHandler(async (req, res) => {
  const code = z.string().parse(req.params.code);
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const result = await cancelSeries(code, email);
  wake();
  res.json(result);
}));

publicRouter.post('/waitlist', asyncHandler(async (req, res) => {
  const input = z.object({
    providerId: z.number().int(),
    serviceId: z.number().int(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    customer: z.object({
      name: z.string().min(2).max(120),
      email: z.string().email(),
      phone: z.string().max(30).optional(),
    }),
  }).parse(req.body);
  const today = new Date();
  const dayStart = new Date(`${input.date}T00:00:00`);
  if (isNaN(dayStart.getTime()) || dayStart.getTime() < new Date(today.toDateString()).getTime()) {
    return res.status(400).json({ error: 'Pick a date that is today or later' });
  }
  res.json(await joinWaitlist(input));
}));

// read-only coupon check for the booking form; the authoritative validation
// (FOR UPDATE + atomic increment) happens inside the booking transaction
publicRouter.post('/coupons/validate', asyncHandler(async (req, res) => {
  const { code, serviceId } = z.object({
    code: z.string().min(1).max(40),
    serviceId: z.number().int(),
  }).parse(req.body);
  const { rows: [service] } = await pool.query('SELECT * FROM services WHERE id = $1 AND active', [serviceId]);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const { rows: [coupon] } = await pool.query('SELECT * FROM coupons WHERE code = upper($1)', [code.trim()]);
  const problem = validateCoupon(coupon, service.price_cents);
  if (problem) return res.json({ valid: false, reason: problem });
  const discountCents = computeDiscount(coupon, service.price_cents);
  const net = service.price_cents - discountCents;
  let dueNowCents = 0;
  if (service.payment_policy === 'full') dueNowCents = net;
  else if (service.payment_policy === 'deposit') dueNowCents = Math.max(Math.ceil((net * service.deposit_pct) / 100), 100);
  res.json({ valid: true, code: coupon.code, discountCents, finalPriceCents: net, dueNowCents });
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
  if (detail.status !== 'confirmed' && detail.status !== 'pending_payment') {
    return res.status(400).json({ error: `This booking is already ${detail.status}` });
  }
  if (new Date(detail.starts_at) < new Date()) {
    return res.status(400).json({ error: 'Past bookings cannot be cancelled' });
  }
  const { refund } = await cancelBooking(detail.id, 'customer', {
    cancelledBy: 'you',
    reason: 'Cancelled via manage page',
  });
  wake();
  res.json({ ...detail, status: 'cancelled', refund });
}));

// "You will be refunded ₹X" preview for the cancel confirmation dialog
publicRouter.get('/bookings/:code/refund-preview', asyncHandler(async (req, res) => {
  const code = z.string().parse(req.params.code);
  const { email } = z.object({ email: z.string().email() }).parse(req.query);
  const detail = await getBookingDetail(
    'upper(b.code) = upper($1) AND c.email = lower($2)', [code.trim(), email.trim()]
  );
  if (!detail) return res.status(404).json({ error: 'No booking found for that code and email' });
  const { rows: [payment] } = await pool.query(
    `SELECT * FROM payments WHERE booking_id = $1 AND status IN ('captured', 'partially_refunded')`,
    [detail.id]
  );
  if (!payment) return res.json({ paid: false, refund: null });
  const refundable = payment.amount_cents - (await refundedSoFar(payment.id));
  const { refundCents, policy } = computeRefundCents(Math.max(refundable, 0), new Date(detail.starts_at));
  res.json({ paid: true, refund: { amountCents: refundCents, policy, paidCents: payment.amount_cents } });
}));

// data for the printable receipt page (same code+email auth as lookup)
publicRouter.get('/bookings/:code/receipt', asyncHandler(async (req, res) => {
  const code = z.string().parse(req.params.code);
  const { email } = z.object({ email: z.string().email() }).parse(req.query);
  const detail = await getBookingDetail(
    'upper(b.code) = upper($1) AND c.email = lower($2)', [code.trim(), email.trim()]
  );
  if (!detail) return res.status(404).json({ error: 'No booking found for that code and email' });
  const { rows: payments } = await pool.query(
    `SELECT p.*,
            COALESCE(json_agg(json_build_object(
              'id', r.id, 'amount_cents', r.amount_cents, 'reason', r.reason,
              'status', r.status, 'created_at', r.created_at
            ) ORDER BY r.created_at) FILTER (WHERE r.id IS NOT NULL), '[]') AS refunds
     FROM payments p
     LEFT JOIN refunds r ON r.payment_id = p.id
     WHERE p.booking_id = $1
     GROUP BY p.id ORDER BY p.created_at`,
    [detail.id]
  );
  res.json({ ...detail, payments });
}));

publicRouter.post('/bookings/:code/review', asyncHandler(async (req, res) => {
  const code = z.string().parse(req.params.code);
  const { email, rating, comment } = z.object({
    email: z.string().email(),
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(2000).default(''),
  }).parse(req.body);
  const detail = await getBookingDetail(
    'upper(b.code) = upper($1) AND c.email = lower($2)', [code.trim(), email.trim()]
  );
  if (!detail) return res.status(404).json({ error: 'No booking found for that code and email' });
  const review = await submitReview(detail, rating, comment);
  if (!review) return res.status(409).json({ error: 'This booking has already been reviewed' });
  res.status(201).json(review);
}));

publicRouter.post('/bookings/:code/reschedule', asyncHandler(async (req, res) => {
  const code = z.string().parse(req.params.code);
  const { email, start } = z.object({ email: z.string().email(), start: z.string() }).parse(req.body);
  const detail = await getBookingDetail(
    'upper(b.code) = upper($1) AND c.email = lower($2)', [code.trim(), email.trim()]
  );
  if (!detail) return res.status(404).json({ error: 'No booking found for that code and email' });
  await rescheduleBooking(detail.id, start, 'customer');
  wake();
  res.json(await getBookingDetail('b.id = $1', [detail.id]));
}));
