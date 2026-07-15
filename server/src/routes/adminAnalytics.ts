import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/errors.js';

// Mounted under /api/admin (behind requireAdmin) from admin.ts.
// Date bucketing follows the Postgres server timezone — consistent with the
// slot engine and /stats; do not mix in AT TIME ZONE here alone.
export const analyticsRouter = Router();

analyticsRouter.get('/analytics', asyncHandler(async (req, res) => {
  const { days } = z.object({
    days: z.coerce.number().int().min(7).max(365).default(30),
  }).parse(req.query);

  const [timeseries, heatmap, services, statusRates, customers] = await Promise.all([
    // gap-filled daily bookings / net revenue / cancellations
    pool.query(
      `SELECT d::date AS day,
              count(b.id) FILTER (WHERE b.status IN ('confirmed','completed'))::int AS bookings,
              coalesce(sum(b.price_cents - b.discount_cents)
                       FILTER (WHERE b.status IN ('confirmed','completed')), 0)::int AS revenue_cents,
              count(b.id) FILTER (WHERE b.status = 'cancelled')::int AS cancelled
       FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') d
       LEFT JOIN bookings b ON b.starts_at::date = d::date
       GROUP BY d ORDER BY d`,
      [days]
    ),
    // weekday × hour demand
    pool.query(
      `SELECT extract(dow FROM starts_at)::int AS dow,
              extract(hour FROM starts_at)::int AS hour,
              count(*)::int AS count
       FROM bookings
       WHERE status IN ('confirmed','completed') AND starts_at >= current_date - $1::int
       GROUP BY 1, 2`,
      [days]
    ),
    // per-service performance
    pool.query(
      `SELECT s.id, s.name, p.name AS provider_name, p.color, p.emoji,
              count(b.id)::int AS bookings,
              coalesce(sum(b.price_cents - b.discount_cents), 0)::int AS revenue_cents
       FROM services s
       JOIN providers p ON p.id = s.provider_id
       LEFT JOIN bookings b ON b.service_id = s.id
         AND b.status IN ('confirmed','completed') AND b.starts_at >= current_date - $1::int
       GROUP BY s.id, p.name, p.color, p.emoji
       HAVING count(b.id) > 0
       ORDER BY revenue_cents DESC
       LIMIT 12`,
      [days]
    ),
    pool.query(
      `SELECT status, count(*)::int AS count
       FROM bookings WHERE created_at >= current_date - $1::int
       GROUP BY status ORDER BY count DESC`,
      [days]
    ),
    // new vs returning, per booking in the window
    pool.query(
      `SELECT count(*) FILTER (WHERE b.created_at = f.first_at)::int AS new_bookings,
              count(*) FILTER (WHERE b.created_at > f.first_at)::int AS returning_bookings,
              count(DISTINCT b.customer_id) FILTER (WHERE f.first_at >= current_date - $1::int)::int AS new_customers
       FROM bookings b
       JOIN (SELECT customer_id, min(created_at) AS first_at FROM bookings GROUP BY customer_id) f
         ON f.customer_id = b.customer_id
       WHERE b.created_at >= current_date - $1::int`,
      [days]
    ),
  ]);

  res.json({
    days,
    timeseries: timeseries.rows,
    heatmap: heatmap.rows,
    services: services.rows,
    statusRates: statusRates.rows,
    customers: customers.rows[0],
  });
}));
