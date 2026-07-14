export type BusinessType = 'doctor' | 'salon' | 'turf';
export type BookingStatus = 'confirmed' | 'completed' | 'cancelled' | 'no_show';

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
  active?: boolean;
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
  active: boolean;
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
}

export interface AdminStats {
  today_confirmed: string;
  next7_confirmed: string;
  month_revenue_cents: string;
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
