/**
 * Gateway adapter contract. The mock provider is the only implementation
 * shipped; a Razorpay/Stripe adapter drops in by implementing this interface
 * and registering it in ./index.ts (the signature scheme below intentionally
 * mirrors Razorpay's HMAC flow so a real adapter is a straight swap).
 */
export interface PaymentProvider {
  readonly name: 'mock' | 'razorpay';
  /** Create a gateway order. amountCents is INR paise. */
  createOrder(args: {
    amountCents: number;
    receipt: string; // booking code
    notes?: Record<string, string>;
  }): Promise<{ orderId: string }>;
  /** Checkout callback signature: HMAC-SHA256(`${orderId}|${paymentId}`, secret). */
  verifyCheckoutSignature(args: { orderId: string; paymentId: string; signature: string }): boolean;
  /** Issue a (partial) refund against a captured payment. */
  refund(args: {
    paymentId: string;
    amountCents: number;
    notes?: Record<string, string>;
  }): Promise<{ refundId: string; status: 'pending' | 'processed'; raw: unknown }>;
  /** Info the client needs to open checkout. */
  checkoutPublicConfig(): { provider: 'mock' | 'razorpay'; keyId?: string };
}
