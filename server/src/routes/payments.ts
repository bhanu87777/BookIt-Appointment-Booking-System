import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/errors.js';
import { paymentProvider } from '../services/payments/index.js';
import { mockSignature } from '../services/payments/mock.js';
import { capturePayment } from '../services/payments/capture.js';
import { getBookingDetail } from '../services/booking.js';
import { wake } from '../services/notify/dispatcher.js';

export const paymentsRouter = Router();

/**
 * Simulated gateway server (mock mode only). Plays the role Razorpay's
 * checkout popup + API would: mints a payment id and signs it. A real
 * gateway integration never hits this route.
 */
paymentsRouter.post('/mock/pay', asyncHandler(async (req, res) => {
  if (paymentProvider.name !== 'mock') return res.status(404).json({ error: 'Not found' });
  const { orderId, outcome } = z.object({
    orderId: z.string(),
    outcome: z.enum(['success', 'failure']).default('success'),
  }).parse(req.body);

  const { rows: [payment] } = await pool.query('SELECT * FROM payments WHERE order_id = $1', [orderId]);
  if (!payment) return res.status(404).json({ error: 'Order not found' });
  if (payment.status === 'captured') return res.status(400).json({ error: 'Order already paid' });

  if (outcome === 'failure') {
    // a failed attempt leaves the booking pending — retry until the hold expires
    await pool.query(
      `UPDATE payments SET error = 'Payment failed (simulated)', updated_at = now() WHERE id = $1`,
      [payment.id]
    );
    await pool.query(
      `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1, 'payment_failed', 'system', 'Simulated failure')`,
      [payment.booking_id]
    );
    return res.status(402).json({ error: 'Payment failed (simulated). You can retry until the hold expires.' });
  }

  const paymentId = 'mockpay_' + crypto.randomBytes(8).toString('hex');
  res.json({ paymentId, signature: mockSignature(orderId, paymentId) });
}));

/** Checkout-handler verification — signature check then idempotent capture. */
paymentsRouter.post('/verify', asyncHandler(async (req, res) => {
  const { code, orderId, paymentId, signature } = z.object({
    code: z.string().min(4),
    orderId: z.string(),
    paymentId: z.string(),
    signature: z.string(),
  }).parse(req.body);

  const { rows: [payment] } = await pool.query(
    `SELECT p.*, b.code AS booking_code FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.order_id = $1`,
    [orderId]
  );
  if (!payment || payment.booking_code.toUpperCase() !== code.trim().toUpperCase()) {
    return res.status(404).json({ error: 'Order not found' });
  }
  if (payment.status !== 'captured') {
    if (!paymentProvider.verifyCheckoutSignature({ orderId, paymentId, signature })) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }
    await capturePayment({ orderId, paymentId, method: paymentProvider.name });
    wake(); // deliver the receipt email now
  }
  res.json(await getBookingDetail('b.id = $1', [payment.booking_id]));
}));
