/**
 * Coupon math shared by the read-only validate endpoint and the
 * authoritative in-transaction check inside createBooking.
 */
export function validateCoupon(coupon: any, priceCents: number): string | null {
  if (!coupon) return 'Invalid coupon code';
  if (!coupon.active) return 'This coupon is no longer active';
  const now = new Date();
  if (coupon.valid_from && new Date(coupon.valid_from) > now) return 'This coupon is not active yet';
  if (coupon.valid_to && new Date(coupon.valid_to) < now) return 'This coupon has expired';
  if (coupon.min_amount_cents > priceCents) {
    return `This coupon needs a minimum order of ₹${(coupon.min_amount_cents / 100).toLocaleString('en-IN')}`;
  }
  if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) return 'This coupon has been fully redeemed';
  return null;
}

export function computeDiscount(coupon: any, priceCents: number): number {
  return coupon.type === 'percent'
    ? Math.floor((priceCents * coupon.value) / 100)
    : Math.min(coupon.value, priceCents);
}
