import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/errors.js';

// Mounted under /api/admin (behind requireAdmin) from admin.ts.
export const adminCustomersRouter = Router();

const SORTS: Record<string, string> = {
  recent: 'last_visit DESC NULLS LAST',
  spend: 'total_spend_cents DESC',
  bookings: 'booking_count DESC',
  name: 'c.name ASC',
};

const customerAggregates = `
  count(b.id)::int                                                              AS booking_count,
  coalesce(sum(b.price_cents - b.discount_cents)
           FILTER (WHERE b.status = 'completed'), 0)::int                       AS total_spend_cents,
  max(b.starts_at) FILTER (WHERE b.status = 'completed')                        AS last_visit,
  count(b.id) FILTER (WHERE b.status = 'no_show')::int                          AS no_show_count,
  count(b.id) FILTER (WHERE b.status = 'confirmed' AND b.starts_at > now())::int AS upcoming
`;

adminCustomersRouter.get('/customers', asyncHandler(async (req, res) => {
  const q = z.object({
    search: z.string().optional(),
    sort: z.enum(['recent', 'spend', 'bookings', 'name']).default('recent'),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }).parse(req.query);

  const params: unknown[] = [];
  let where = 'true';
  if (q.search) {
    params.push(`%${q.search}%`);
    where = `(c.name ILIKE $1 OR c.email ILIKE $1 OR c.phone ILIKE $1)`;
  }
  params.push(q.limit);

  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.email, c.phone, c.created_at,
            (c.password_hash IS NOT NULL) AS has_account,
            coalesce((SELECT sum(points)::int FROM loyalty_ledger l WHERE l.customer_id = c.id), 0) AS points_balance,
            ${customerAggregates}
     FROM customers c
     LEFT JOIN bookings b ON b.customer_id = c.id
     WHERE ${where}
     GROUP BY c.id
     ORDER BY ${SORTS[q.sort]}
     LIMIT $${params.length}`,
    params
  );
  res.json(rows);
}));

adminCustomersRouter.get('/customers/:id', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { rows: [customer] } = await pool.query(
    `SELECT c.id, c.name, c.email, c.phone, c.notes, c.created_at,
            (c.password_hash IS NOT NULL) AS has_account,
            coalesce((SELECT sum(points)::int FROM loyalty_ledger l WHERE l.customer_id = c.id), 0) AS points_balance,
            ${customerAggregates}
     FROM customers c
     LEFT JOIN bookings b ON b.customer_id = c.id
     WHERE c.id = $1
     GROUP BY c.id`,
    [id]
  );
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const { rows: bookings } = await pool.query(
    `SELECT b.*, s.name AS service_name, p.name AS provider_name, p.emoji, p.color
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     JOIN providers p ON p.id = b.provider_id
     WHERE b.customer_id = $1
     ORDER BY b.starts_at DESC
     LIMIT 100`,
    [id]
  );
  res.json({ ...customer, bookings });
}));

adminCustomersRouter.patch('/customers/:id/notes', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { notes } = z.object({ notes: z.string().max(5000) }).parse(req.body);
  const { rows: [row] } = await pool.query(
    'UPDATE customers SET notes = $2 WHERE id = $1 RETURNING id, notes', [id, notes]
  );
  if (!row) return res.status(404).json({ error: 'Customer not found' });
  res.json(row);
}));
