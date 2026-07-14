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
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ services
CREATE TABLE IF NOT EXISTS services (
  id           SERIAL PRIMARY KEY,
  provider_id  INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  duration_min INT NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  buffer_min   INT NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 120),  -- prep/cleanup gap enforced around bookings
  price_cents  INT NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_services_provider ON services(provider_id);

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
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  phone      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
               CHECK (status IN ('confirmed', 'completed', 'cancelled', 'no_show')),
  price_cents  INT NOT NULL DEFAULT 0,                  -- snapshot of the service price at booking time
  notes        TEXT NOT NULL DEFAULT '',
  cancel_token UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),

  -- THE conflict-prevention constraint. Two bookings for the same provider
  -- whose [starts_at, ends_at) ranges overlap cannot both be active.
  -- Cancelled / no-show bookings are excluded so their slots free up.
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    provider_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('confirmed', 'completed'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_provider_time ON bookings(provider_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

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
