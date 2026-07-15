-- ============================================================================
-- Appointment Booking System — PostgreSQL schema
--
-- Conflict prevention strategy (defense in depth):
--   1. Application layer: slot is re-validated inside the booking transaction
--      while holding a per-provider advisory lock (pg_advisory_xact_lock).
--   2. Database layer: a GiST EXCLUSION constraint on (provider_id, time range)
--      makes overlapping active bookings *impossible* to persist, even if the
--      application layer is bypassed or buggy. This is the last line of defense.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Range type over TIME (Postgres ships tstzrange but not a time-of-day range)
DO $$ BEGIN
  CREATE TYPE timerange AS RANGE (subtype = time);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------- admin users
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------- providers
-- A provider is a bookable resource: a doctor, a stylist, or a turf/court.
CREATE TABLE IF NOT EXISTS providers (
  id                   SERIAL PRIMARY KEY,
  business_type        TEXT NOT NULL CHECK (business_type IN ('doctor', 'salon', 'turf')),
  name                 TEXT NOT NULL,
  title                TEXT NOT NULL DEFAULT '',        -- e.g. "Cardiologist", "Senior Stylist", "5-a-side football"
  bio                  TEXT NOT NULL DEFAULT '',
  emoji                TEXT NOT NULL DEFAULT '📅',
  color                TEXT NOT NULL DEFAULT '#6366f1',
  slot_step_min        INT  NOT NULL DEFAULT 15 CHECK (slot_step_min BETWEEN 5 AND 120),
  min_lead_min         INT  NOT NULL DEFAULT 60 CHECK (min_lead_min >= 0),      -- bookings must be at least this far in the future
  booking_horizon_days INT  NOT NULL DEFAULT 30 CHECK (booking_horizon_days BETWEEN 1 AND 365),
  reschedule_cutoff_min INT NOT NULL DEFAULT 120 CHECK (reschedule_cutoff_min >= 0), -- customers may self-reschedule until this close to start
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE providers ADD COLUMN IF NOT EXISTS reschedule_cutoff_min INT NOT NULL DEFAULT 120 CHECK (reschedule_cutoff_min >= 0);

-- ------------------------------------------------------------------ services
CREATE TABLE IF NOT EXISTS services (
  id             SERIAL PRIMARY KEY,
  provider_id    INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  duration_min   INT NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  buffer_min     INT NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 120),  -- prep/cleanup gap enforced around bookings
  price_cents    INT NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  payment_policy TEXT NOT NULL DEFAULT 'none' CHECK (payment_policy IN ('none', 'deposit', 'full')),
  deposit_pct    INT NOT NULL DEFAULT 50 CHECK (deposit_pct BETWEEN 1 AND 100),
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_services_provider ON services(provider_id);
ALTER TABLE services ADD COLUMN IF NOT EXISTS payment_policy TEXT NOT NULL DEFAULT 'none' CHECK (payment_policy IN ('none', 'deposit', 'full'));
ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_pct INT NOT NULL DEFAULT 50 CHECK (deposit_pct BETWEEN 1 AND 100);

-- ------------------------------------------------- weekly recurring schedule
-- Working windows per weekday (0 = Sunday .. 6 = Saturday). A provider may
-- have multiple windows per day (e.g. 09:00-13:00 and 16:00-20:00).
CREATE TABLE IF NOT EXISTS schedules (
  id          SERIAL PRIMARY KEY,
  provider_id INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  weekday     INT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  CHECK (start_time < end_time),
  -- windows on the same weekday must not overlap each other
  CONSTRAINT schedules_no_overlap EXCLUDE USING gist (
    provider_id WITH =,
    weekday     WITH =,
    timerange(start_time, end_time) WITH &&
  )
);
CREATE INDEX IF NOT EXISTS idx_schedules_provider ON schedules(provider_id);

-- Recurring breaks inside working windows (lunch, maintenance, prayer, etc.)
CREATE TABLE IF NOT EXISTS breaks (
  id          SERIAL PRIMARY KEY,
  provider_id INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  weekday     INT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  label       TEXT NOT NULL DEFAULT 'Break',
  CHECK (start_time < end_time)
);
CREATE INDEX IF NOT EXISTS idx_breaks_provider ON breaks(provider_id);

-- One-off unavailability (vacation, sick day, tournament, renovation…)
CREATE TABLE IF NOT EXISTS time_off (
  id          SERIAL PRIMARY KEY,
  provider_id INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  CHECK (starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS idx_time_off_provider ON time_off(provider_id, starts_at);

-- ----------------------------------------------------------------- customers
CREATE TABLE IF NOT EXISTS customers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT NOT NULL DEFAULT '',
  password_hash TEXT,                        -- NULL = guest-only record (no account)
  notes         TEXT NOT NULL DEFAULT '',    -- private admin/CRM notes
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';

-- ------------------------------------------------------------------ bookings
CREATE TABLE IF NOT EXISTS bookings (
  id           SERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,                    -- short human-friendly reference, e.g. BK-7F3K2A
  provider_id  INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  service_id   INT NOT NULL REFERENCES services(id),
  customer_id  INT NOT NULL REFERENCES customers(id),
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'confirmed'
               CHECK (status IN ('pending_payment', 'confirmed', 'completed', 'cancelled', 'no_show')),
  price_cents  INT NOT NULL DEFAULT 0,                  -- snapshot of the service price at booking time
  discount_cents   INT NOT NULL DEFAULT 0 CHECK (discount_cents >= 0), -- coupon + redeemed points
  coupon_code      TEXT,                                -- snapshot of the applied coupon
  points_redeemed  INT NOT NULL DEFAULT 0 CHECK (points_redeemed >= 0),
  amount_due_cents INT NOT NULL DEFAULT 0,              -- online amount at booking time
  expires_at   TIMESTAMPTZ,                             -- payment hold deadline (pending_payment only)
  notes        TEXT NOT NULL DEFAULT '',
  cancel_token UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),

  -- THE conflict-prevention constraint. Two bookings for the same provider
  -- whose [starts_at, ends_at) ranges overlap cannot both be active.
  -- pending_payment HOLDS the slot while the customer pays; cancelled /
  -- no-show bookings are excluded so their slots free up.
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    provider_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('pending_payment', 'confirmed', 'completed'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_provider_time ON bookings(provider_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

-- upgrade path for existing databases (schema.sql is replayed idempotently)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_cents INT NOT NULL DEFAULT 0 CHECK (discount_cents >= 0);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS coupon_code TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS points_redeemed INT NOT NULL DEFAULT 0 CHECK (points_redeemed >= 0);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS amount_due_cents INT NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_bookings_pending_expiry ON bookings(expires_at) WHERE status = 'pending_payment';

-- widen the status CHECK to include pending_payment (drop + re-add only when stale)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'bookings'::regclass AND conname = 'bookings_status_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%pending_payment%') THEN
    ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
    ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
      CHECK (status IN ('pending_payment', 'confirmed', 'completed', 'cancelled', 'no_show'));
  END IF;
END $$;

-- CRITICAL: pending_payment must occupy the slot. Rebuild the exclusion
-- constraint only when its WHERE clause is the old one (avoids a GiST
-- rebuild on every migrate run). slots.ts must use the same status list.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'bookings'::regclass AND conname = 'bookings_no_overlap'
               AND pg_get_constraintdef(oid) NOT LIKE '%pending_payment%') THEN
    ALTER TABLE bookings DROP CONSTRAINT bookings_no_overlap;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'bookings'::regclass AND conname = 'bookings_no_overlap') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
      provider_id WITH =,
      tstzrange(starts_at, ends_at) WITH &&
    ) WHERE (status IN ('pending_payment', 'confirmed', 'completed'));
  END IF;
END $$;

-- ------------------------------------------------------------------ payments
CREATE TABLE IF NOT EXISTS payments (
  id           SERIAL PRIMARY KEY,
  booking_id   INT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (provider IN ('mock', 'razorpay')),
  order_id     TEXT NOT NULL UNIQUE,               -- gateway order id (mock_order_…)
  payment_id   TEXT,                               -- gateway payment id, set on capture
  amount_cents INT  NOT NULL CHECK (amount_cents > 0),   -- INR paise
  currency     TEXT NOT NULL DEFAULT 'INR',
  status       TEXT NOT NULL DEFAULT 'created'
               CHECK (status IN ('created', 'captured', 'partially_refunded', 'refunded', 'failed')),
  method       TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  raw          JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
-- one live (non-failed) payment attempt per booking; retries reuse the order
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_booking_live ON payments(booking_id) WHERE status <> 'failed';

-- ------------------------------------------------------------------- refunds
CREATE TABLE IF NOT EXISTS refunds (
  id                 SERIAL PRIMARY KEY,
  payment_id         INT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  provider_refund_id TEXT NOT NULL,
  amount_cents       INT NOT NULL CHECK (amount_cents > 0),
  reason             TEXT NOT NULL DEFAULT '',       -- customer_cancel | admin_cancel | admin_manual | expired_capture
  status             TEXT NOT NULL DEFAULT 'processed' CHECK (status IN ('pending', 'processed', 'failed')),
  raw                JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id);

-- ------------------------------------------------------------------- coupons
CREATE TABLE IF NOT EXISTS coupons (
  id               SERIAL PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,             -- stored uppercase
  type             TEXT NOT NULL CHECK (type IN ('percent', 'fixed')),
  value            INT  NOT NULL CHECK (value > 0),  -- percent (1-100) or paise
  max_uses         INT,                              -- NULL = unlimited
  used_count       INT  NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  min_amount_cents INT  NOT NULL DEFAULT 0,
  valid_from       TIMESTAMPTZ,
  valid_to         TIMESTAMPTZ,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (type <> 'percent' OR value <= 100)
);

-- ------------------------------------------------------------ loyalty points
-- Append-only ledger; balance = sum(points). The partial unique index makes
-- earn/reverse idempotent per booking even under admin retries.
CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id          SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  booking_id  INT REFERENCES bookings(id) ON DELETE SET NULL,
  points      INT NOT NULL,                -- positive = earn, negative = redeem
  reason      TEXT NOT NULL CHECK (reason IN ('earned_completed', 'redeemed', 'redemption_reversed', 'admin_adjust')),
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_customer ON loyalty_ledger(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_loyalty_booking_reason
  ON loyalty_ledger(booking_id, reason) WHERE booking_id IS NOT NULL;

-- ------------------------------------------------------------ booking series
-- A weekly/biweekly run of bookings. Occurrences are ordinary bookings rows
-- (constraint, reminders, cancellation all work untouched) linked by series_id.
CREATE TABLE IF NOT EXISTS booking_series (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,                    -- SR-XXXXXX
  provider_id INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  service_id  INT NOT NULL REFERENCES services(id),
  customer_id INT NOT NULL REFERENCES customers(id),
  frequency   TEXT NOT NULL CHECK (frequency IN ('weekly', 'biweekly')),
  occurrences INT NOT NULL CHECK (occurrences BETWEEN 2 AND 12),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS series_id INT REFERENCES booking_series(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_series ON bookings(series_id) WHERE series_id IS NOT NULL;

-- ------------------------------------------------------------------ waitlist
CREATE TABLE IF NOT EXISTS waitlist (
  id          SERIAL PRIMARY KEY,
  provider_id INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  service_id  INT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'waiting'
              CHECK (status IN ('waiting', 'notified', 'converted', 'expired')),
  token       UUID NOT NULL DEFAULT gen_random_uuid(),
  notified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, service_id, date, email)        -- no duplicate joins
);
CREATE INDEX IF NOT EXISTS idx_waitlist_match ON waitlist(provider_id, date, status);

-- ------------------------------------------------------------------- reviews
-- One review per booking, only for completed bookings (enforced in the API).
-- provider_id/customer_id are denormalized from the booking row (never taken
-- from client input) so rating aggregates stay one cheap indexed query.
CREATE TABLE IF NOT EXISTS reviews (
  id          SERIAL PRIMARY KEY,
  booking_id  INT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  provider_id INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  rating      INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT NOT NULL DEFAULT '',
  hidden      BOOLEAN NOT NULL DEFAULT FALSE,   -- admin moderation
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reviews_provider_visible ON reviews(provider_id) WHERE NOT hidden;

-- ----------------------------------------------------------------- favorites
CREATE TABLE IF NOT EXISTS favorites (
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  provider_id INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, provider_id)
);

-- ------------------------------------------------------- notification outbox
-- Every outbound message (confirmations, cancellations, reminders, waitlist
-- pings…) is a row here. An in-process dispatcher claims due rows with
-- FOR UPDATE SKIP LOCKED and delivers them, so email gets retries with
-- backoff, an audit trail, idempotent enqueues, and survives restarts.
CREATE TABLE IF NOT EXISTS notifications (
  id              SERIAL PRIMARY KEY,
  booking_id      INT REFERENCES bookings(id) ON DELETE CASCADE,
  waitlist_id     INT,                        -- FK attached next to the waitlist table
  channel         TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'sms', 'whatsapp')),
  template        TEXT NOT NULL CHECK (template IN
                    ('confirmation', 'cancellation', 'rescheduled', 'receipt',
                     'reminder_24h', 'reminder_1h', 'waitlist_slot_open',
                     'series_summary', 'series_cancelled')),
  recipient       TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',        -- template extras; content renders at send time
  scheduled_for   TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- backoff cursor
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'void')),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (booking_id IS NOT NULL OR waitlist_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications(next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notifications_booking ON notifications(booking_id);
-- one live reminder of each kind per booking per channel (idempotent enqueue;
-- rescheduling voids old reminders so fresh ones can be enqueued)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_notifications_reminder
  ON notifications(booking_id, channel, template)
  WHERE template IN ('reminder_24h', 'reminder_1h') AND status <> 'void';
DO $$ BEGIN
  ALTER TABLE notifications ADD CONSTRAINT notifications_waitlist_fk
    FOREIGN KEY (waitlist_id) REFERENCES waitlist(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ------------------------------------------------------------------ audit log
CREATE TABLE IF NOT EXISTS booking_events (
  id         SERIAL PRIMARY KEY,
  booking_id INT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  event      TEXT NOT NULL,          -- created | cancelled | completed | no_show | email_sent …
  actor      TEXT NOT NULL,          -- 'customer' | 'admin:<email>' | 'system'
  detail     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_events_booking ON booking_events(booking_id);
