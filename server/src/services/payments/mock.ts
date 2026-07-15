import crypto from 'node:crypto';
import { config } from '../../config.js';
import type { PaymentProvider } from './types.js';

const rand = (len = 14) => crypto.randomBytes(10).toString('base64url').replace(/[-_]/g, '').slice(0, len);

export function mockSignature(orderId: string, paymentId: string): string {
  return crypto.createHmac('sha256', config.payments.mockSecret).update(`${orderId}|${paymentId}`).digest('hex');
}

/**
 * Built-in simulated gateway: orders are minted locally, "checkout" happens
 * via POST /api/payments/mock/pay (which plays the gateway server and signs
 * the payment), and verification recomputes the same HMAC — exactly the
 * shape of Razorpay's flow, with zero external accounts.
 */
export class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  async createOrder(): Promise<{ orderId: string }> {
    return { orderId: `mock_order_${rand()}` };
  }

  verifyCheckoutSignature({ orderId, paymentId, signature }: { orderId: string; paymentId: string; signature: string }): boolean {
    const expected = mockSignature(orderId, paymentId);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async refund({ amountCents }: { amountCents: number }) {
    return { refundId: `mockrf_${rand()}`, status: 'processed' as const, raw: { simulated: true, amountCents } };
  }

  checkoutPublicConfig() {
    return { provider: 'mock' as const };
  }
}
