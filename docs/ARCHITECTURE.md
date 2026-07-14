# 🏗️ BookIt — Architecture

How the pieces fit together, from the browser down to the Postgres exclusion
constraint that makes double-booking impossible.

---

## 1. The big picture

BookIt is an npm-workspaces monorepo with two deployable pieces that talk over a
small JSON/REST API:

```
┌──────────────────────────┐        HTTP / JSON        ┌───────────────────────────┐
│  client  (React + Vite)  │  ───────────────────────▶ │  server  (Express + TS)   │
│                          │                            │                           │
│  • customer site         │      /api/*  (public)      │  • routes  (public/admin) │
│  • admin panel (JWT)     │ ◀───────────────────────── │  • services (slots,       │
│                          │      /api/admin/* (JWT)    │     booking, email)       │
└──────────────────────────┘                            └────────────┬──────────────┘
                                                                      │  pg (SQL)
                                                                      ▼
                                                         ┌───────────────────────────┐
                                                         │  PostgreSQL               │
                                                         │  • GiST exclusion         │
                                                         │    constraints            │
                                                         │  • advisory locks         │
                                                         └───────────────────────────┘
```

- **client** — a Vite + React + TypeScript SPA (React Router). Two areas share one
  build: the public customer site and the JWT-guarded `/admin` panel.
- **server** — an Express + TypeScript API. No ORM: raw parameterised SQL through
  `pg`, Zod validation on every request body/query.
- **PostgreSQL** — not just a store. The database itself is the final guarantor of
  correctness through GiST exclusion constraints and advisory locks.

---

## 2. Server layout

```
server/src/
├── index.ts              # app bootstrap, CORS, JSON, /api/health, routers
├── config.ts             # typed env config (DATABASE_URL, JWT_SECRET, SMTP…)
├── db/
│   ├── pool.ts           # shared pg Pool
│   ├── schema.sql        # full schema incl. exclusion constraints & types
│   ├── migrate.ts        # creates the DB if absent + applies schema (idempotent)
│   └── seed.ts           # demo data: 6 providers, services, schedules, bookings
├── middleware/
│   ├── auth.ts           # JWT verification for /api/admin/*
│   └── errors.ts         # central error handler (maps 23P01 → 409, Zod → 400)
├── routes/
│   ├── public.ts         # catalog, slots, create/lookup/cancel booking, login
│   └── admin.ts          # stats, bookings admin, providers/schedules/services
└── services/
    ├── slots.ts          # the availability engine
    ├── booking.ts        # transactional booking (locks + re-validation)
    └── email.ts          # confirmation / cancellation emails (SMTP or outbox)
```

Everything routes through `services/` — no route handler touches booking logic or
the slot engine directly except by calling into these modules.

---

## 3. Data model

| Table | Purpose |
|-------|---------|
| `users` | Admin accounts (bcrypt password hash). |
| `providers` | A doctor / salon / turf, with a `type` and booking policy (slot step, min lead time, booking horizon). |
| `services` | Per-provider offerings: name, duration, buffer, price. |
| `schedules` | Weekly working windows per provider (guarded by an exclusion constraint so windows can't overlap). |
| `breaks` | Recurring in-day breaks (e.g. lunch). |
| `time_off` | One-off closures (vacations, maintenance). |
| `customers` | Lightweight customer records keyed by email. |
| `bookings` | The core record. Carries the `bookings_no_overlap` exclusion constraint. |
| `booking_events` | Audit trail: created, status changes, emails sent. |

A custom `timerange` range type backs the GiST exclusion constraints.

---

## 4. Request flow: creating a booking

```
POST /api/bookings
  │
  ├─ 1. Zod validates the body (providerId, serviceId, date, startTime, customer…)
  │
  ├─ 2. BEGIN transaction
  │       └─ pg_advisory_xact_lock(42, provider_id)     ← serialises this provider
  │
  ├─ 3. Re-run the slot engine INSIDE the txn against live schedule/breaks/
  │      time-off/existing bookings. Requested start must still be a valid slot.
  │
  ├─ 4. INSERT booking (status = 'confirmed')
  │       └─ bookings_no_overlap EXCLUDE constraint is the last line of defence
  │
  ├─ 5. Write a booking_events row + send confirmation email
  │
  └─ 6. COMMIT  →  201 with booking code
          on overlap: Postgres raises 23P01 → mapped to 409 Conflict
```

This is the heart of the project — see [§6](#6-zero-double-booking-three-layers).

---

## 5. The slot engine (`services/slots.ts`)

Given a provider, service and date, the engine walks each working window in
`slot_step_min` increments and keeps a candidate start time only if — after
padding with the service's `buffer` — it clears **all** of:

- recurring **breaks**,
- one-off **time-off** periods,
- **existing bookings** (confirmed/completed),
- the provider's **minimum lead time**, and
- the **booking horizon** (how far ahead booking is allowed).

The same function runs both when rendering the grid *and* inside the booking
transaction, so what the customer sees and what the server accepts can never
drift apart.

---

## 6. Zero double-booking: three layers

Two people must never hold the same slot — even under a race between concurrent
requests. BookIt enforces this with three independent layers:

1. **Advisory lock** — `pg_advisory_xact_lock(42, provider_id)` serialises
   concurrent attempts for the *same* provider, while different providers book
   fully in parallel. Auto-released at commit/rollback.

2. **In-transaction re-validation** — the requested start must still be a slot
   the engine would generate *right now*. A hand-crafted API call can't book a
   closed day or a break.

3. **Postgres exclusion constraint** — the final guarantee. Even raw SQL cannot
   persist an overlap:

   ```sql
   CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
     provider_id WITH =,
     tstzrange(starts_at, ends_at) WITH &&
   ) WHERE (status IN ('confirmed', 'completed'))
   ```

   The partial `WHERE` means cancelled/no-show bookings automatically free their
   slot. A conflicting insert fails with SQLSTATE `23P01`, which the error
   handler maps to `409 Conflict`, and the UI refreshes the slot grid.

---

## 7. Client layout

```
client/src/
├── App.tsx               # React Router route table (public + /admin)
├── api.ts                # typed fetch wrapper (attaches admin JWT)
├── format.ts             # currency / date helpers
├── components/Layout.tsx # public shell (nav + footer)
├── pages/                # Home, Providers (browse), ProviderDetail (booking
│                         #   flow), Confirmation, Manage
└── admin/                # AdminLayout, AdminLogin, Dashboard, Bookings,
                          #   DayView, Providers, ProviderEdit
```

**Public routes:** `/`, `/browse/:type`, `/provider/:id`, `/confirmation`, `/manage`
**Admin routes:** `/admin/login`, `/admin` (dashboard), `/admin/bookings`,
`/admin/day`, `/admin/providers`, `/admin/providers/:id`.

The admin JWT is stored client-side and attached by `api.ts`; the server verifies
it in `middleware/auth.ts` for every `/api/admin/*` request.

---

## 8. Email

`services/email.ts` renders confirmation and cancellation emails. If `SMTP_HOST`
is configured it sends via nodemailer; otherwise the rendered HTML is written to
`server/outbox/*.html` so the whole flow works end-to-end with **no mail provider**
during development.
