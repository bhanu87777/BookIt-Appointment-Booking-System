export type BusinessType = 'doctor' | 'salon' | 'turf';
export type BookingStatus = 'pending_payment' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';

export interface BusinessTypeInfo {
  key: BusinessType;
  label: string;
  emoji: string;
  tagline: string;
}

export interface Service {
  id: number;
  provider_id?: number;
  name: string;
  description: string;
  duration_min: number;
  buffer_min: number;
  price_cents: number;
  payment_policy?: 'none' | 'deposit' | 'full';
  deposit_pct?: number;
  active?: boolean;
}

export interface PaymentInfo {
  required: true;
  orderId: string;
  amountCents: number;
  currency: string;
  expiresAt: string;
  provider: 'mock' | 'razorpay';
  keyId?: string;
}

export interface Payment {
  id: number;
  booking_id: number;
  provider: string;
  order_id: string;
  payment_id: string | null;
  amount_cents: number;
  currency: string;
  status: 'created' | 'captured' | 'partially_refunded' | 'refunded' | 'failed';
  method: string;
  error: string;
  created_at: string;
  refunds?: { id: number; amount_cents: number; reason: string; status: string; created_at: string }[];
}

export interface Coupon {
  id: number;
  code: string;
  type: 'percent' | 'fixed';
  value: number;
  max_uses: number | null;
  used_count: number;
  min_amount_cents: number;
  valid_from: string | null;
  valid_to: string | null;
  active: boolean;
}

export interface RefundInfo {
  amountCents: number;
  policy: 'full' | 'partial' | 'none';
  paidCents?: number;
}

export interface ScheduleWindow {
  id?: number;
  weekday: number;
  start_time: string;
  end_time: string;
}

export interface BreakWindow extends ScheduleWindow {
  label: string;
}

export interface TimeOff {
  id: number;
  starts_at: string;
  ends_at: string;
  reason: string;
}

export interface Provider {
  id: number;
  business_type: BusinessType;
  name: string;
  title: string;
  bio: string;
  emoji: string;
  color: string;
  slot_step_min: number;
  min_lead_min: number;
  booking_horizon_days: number;
  reschedule_cutoff_min?: number;
  active: boolean;
  avg_rating?: string | null;
  review_count?: string;
  services?: Service[];
  schedules?: ScheduleWindow[];
  breaks?: BreakWindow[];
  time_off?: TimeOff[];
  service_count?: string;
}

export interface Slot {
  start: string;
  end: string;
}

export interface Booking {
  id: number;
  code: string;
  provider_id: number;
  service_id: number;
  customer_id?: number;
  starts_at: string;
  ends_at: string;
  status: BookingStatus;
  price_cents: number;
  notes: string;
  created_at: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  service_name: string;
  duration_min?: number;
  provider_name: string;
  provider_title?: string;
  business_type: BusinessType;
  emoji: string;
  color: string;
  reschedule_cutoff_min?: number;
  reviewed?: boolean;
  discount_cents?: number;
  coupon_code?: string | null;
  points_redeemed?: number;
  amount_due_cents?: number;
  expires_at?: string | null;
  series_id?: number | null;
  series_code?: string | null;
  payment?: PaymentInfo | null;
  refund?: RefundInfo | null;
  payments?: Payment[];
}

export interface AdminStats {
  today_confirmed: string;
  next7_confirmed: string;
  month_revenue_cents: string;
  month_collected_cents?: string;
  month_refunded_cents?: string;
  cancelled_30d: string;
  created_30d: string;
  active_providers: string;
  customers: string;
  byProvider: {
    id: number;
    name: string;
    emoji: string;
    color: string;
    upcoming: string;
    month_revenue_cents: string;
  }[];
}

export interface AdminUser {
  sub: number;
  email: string;
  name: string;
}
