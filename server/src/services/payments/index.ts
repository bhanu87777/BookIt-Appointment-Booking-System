import { MockProvider } from './mock.js';
import type { PaymentProvider } from './types.js';

// PAYMENT_PROVIDER env selects the adapter; only 'mock' ships today.
// A real gateway adapter registers itself here.
export const paymentProvider: PaymentProvider = new MockProvider();

export type { PaymentProvider } from './types.js';
