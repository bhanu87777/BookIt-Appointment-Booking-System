import bcrypt from 'bcryptjs';
import { pool } from './pool.js';

/** Wipes business data and inserts a rich demo dataset. */
async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `TRUNCATE booking_events, bookings, customers, time_off, breaks, schedules, services, providers, users
       RESTART IDENTITY CASCADE`
    );

    // ---- admin user -------------------------------------------------------
    const hash = await bcrypt.hash('admin123', 10);
    await client.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)`,
      ['admin@bookit.local', hash, 'Admin']
    );

    // ---- providers --------------------------------------------------------
    type P = {
      type: string; name: string; title: string; bio: string; emoji: string; color: string;
      step: number; lead: number; horizon: number;
      services: [string, string, number, number, number][]; // name, desc, duration, buffer, priceCents
      hours: Record<number, [string, string][]>;            // weekday -> windows
      breaks?: [number, string, string, string][];          // weekday, start, end, label
    };

    const providers: P[] = [
      {
        type: 'doctor', name: 'Dr. Asha Rao', title: 'Cardiologist', emoji: '🩺', color: '#0ea5e9',
        bio: '15+ years in preventive cardiology. MBBS, MD (Cardiology). Known for unhurried consultations.',
        step: 15, lead: 120, horizon: 21,
        services: [
          ['New patient consultation', 'Full history, examination and ECG review', 30, 10, 80000],
          ['Follow-up visit', 'Review of reports and medication adjustment', 15, 5, 50000],
          ['Echo screening', 'Echocardiogram with same-visit reading', 45, 15, 250000],
        ],
        hours: { 1: [['09:00', '13:00'], ['17:00', '20:00']], 2: [['09:00', '13:00'], ['17:00', '20:00']], 3: [['09:00', '13:00']], 4: [['09:00', '13:00'], ['17:00', '20:00']], 5: [['09:00', '13:00']], 6: [['10:00', '14:00']] },
        breaks: [[1, '11:00', '11:15', 'Tea break'], [2, '11:00', '11:15', 'Tea break'], [4, '11:00', '11:15', 'Tea break']],
      },
      {
        type: 'doctor', name: 'Dr. Kabir Mehta', title: 'Dermatologist', emoji: '🧴', color: '#14b8a6',
        bio: 'Skin, hair and nail specialist. MD (Dermatology), fellowship in cosmetic dermatology.',
        step: 20, lead: 60, horizon: 30,
        services: [
          ['Consultation', 'Diagnosis and treatment plan', 20, 5, 60000],
          ['Chemical peel session', 'Includes post-care kit', 40, 20, 180000],
          ['Mole / skin-tag removal', 'Minor procedure under local anaesthesia', 30, 15, 220000],
        ],
        hours: { 1: [['10:00', '18:00']], 2: [['10:00', '18:00']], 3: [['10:00', '18:00']], 4: [['10:00', '18:00']], 5: [['10:00', '18:00']] },
        breaks: [[1, '13:30', '14:30', 'Lunch'], [2, '13:30', '14:30', 'Lunch'], [3, '13:30', '14:30', 'Lunch'], [4, '13:30', '14:30', 'Lunch'], [5, '13:30', '14:30', 'Lunch']],
      },
      {
        type: 'salon', name: 'Meera @ Glow Studio', title: 'Senior Stylist', emoji: '💇‍♀️', color: '#ec4899',
        bio: 'Color specialist and bridal stylist. 10 years with Toni&Guy before founding Glow Studio.',
        step: 15, lead: 30, horizon: 14,
        services: [
          ['Haircut & blow-dry', 'Consultation, wash, cut and style', 45, 15, 120000],
          ['Global hair color', 'Ammonia-free color, includes wash', 90, 15, 350000],
          ['Bridal trial makeup', 'Full trial with photos', 120, 30, 600000],
          ['Quick trim', 'Maintenance trim, dry cut', 20, 10, 60000],
        ],
        hours: { 0: [['11:00', '17:00']], 2: [['10:00', '20:00']], 3: [['10:00', '20:00']], 4: [['10:00', '20:00']], 5: [['10:00', '20:00']], 6: [['09:00', '21:00']] },
        breaks: [[6, '13:00', '13:45', 'Lunch']],
      },
      {
        type: 'salon', name: 'Arjun @ FadeLab', title: 'Barber & Groomer', emoji: '💈', color: '#f59e0b',
        bio: 'Precision fades, beard sculpting and hot-towel shaves. Walk-ins never; bookings always.',
        step: 10, lead: 30, horizon: 14,
        services: [
          ['Skin fade + beard', 'Signature fade with beard line-up', 40, 10, 90000],
          ['Classic haircut', 'Scissor cut and style', 30, 10, 60000],
          ['Hot-towel shave', 'Straight razor, hot towel ritual', 25, 5, 50000],
        ],
        hours: { 0: [['10:00', '16:00']], 1: [['11:00', '20:00']], 3: [['11:00', '20:00']], 4: [['11:00', '20:00']], 5: [['11:00', '21:00']], 6: [['10:00', '21:00']] },
      },
      {
        type: 'turf', name: 'GreenKick Arena — Turf 1', title: '5-a-side football turf', emoji: '⚽', color: '#22c55e',
        bio: 'FIFA-approved artificial grass, floodlights, changing rooms. Max 12 players.',
        step: 30, lead: 60, horizon: 30,
        services: [
          ['1 hour slot', 'Full turf, ball included', 60, 0, 120000],
          ['1.5 hour slot', 'Full turf, ball included', 90, 0, 170000],
          ['2 hour slot', 'Full turf, ball + bibs included', 120, 0, 220000],
        ],
        hours: { 0: [['06:00', '23:00']], 1: [['06:00', '23:00']], 2: [['06:00', '23:00']], 3: [['06:00', '23:00']], 4: [['06:00', '23:00']], 5: [['06:00', '23:00']], 6: [['06:00', '23:00']] },
      },
      {
        type: 'turf', name: 'SmashPoint — Badminton Court 2', title: 'Indoor synthetic court', emoji: '🏸', color: '#8b5cf6',
        bio: 'BWF-standard synthetic flooring, tournament lighting, rackets on rent.',
        step: 30, lead: 30, horizon: 21,
        services: [
          ['1 hour court booking', 'Court + shuttles (feather extra)', 60, 0, 40000],
          ['2 hour court booking', 'Court + shuttles (feather extra)', 120, 0, 75000],
        ],
        hours: { 0: [['06:00', '22:00']], 1: [['06:00', '22:00']], 2: [['06:00', '22:00']], 3: [['06:00', '22:00']], 4: [['06:00', '22:00']], 5: [['06:00', '22:00']], 6: [['06:00', '22:00']] },
      },
    ];

    const serviceIds: number[][] = [];
    for (const p of providers) {
      const { rows: [prov] } = await client.query(
        `INSERT INTO providers (business_type, name, title, bio, emoji, color, slot_step_min, min_lead_min, booking_horizon_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [p.type, p.name, p.title, p.bio, p.emoji, p.color, p.step, p.lead, p.horizon]
      );
      const ids: number[] = [];
      for (const [name, desc, dur, buf, price] of p.services) {
        const { rows: [svc] } = await client.query(
          `INSERT INTO services (provider_id, name, description, duration_min, buffer_min, price_cents)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [prov.id, name, desc, dur, buf, price]
        );
        ids.push(svc.id);
      }
      serviceIds.push(ids);
      for (const [weekday, windows] of Object.entries(p.hours)) {
        for (const [start, end] of windows) {
          await client.query(
            `INSERT INTO schedules (provider_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)`,
            [prov.id, Number(weekday), start, end]
          );
        }
      }
      for (const [weekday, start, end, label] of p.breaks ?? []) {
        await client.query(
          `INSERT INTO breaks (provider_id, weekday, start_time, end_time, label) VALUES ($1,$2,$3,$4,$5)`,
          [prov.id, weekday, start, end, label]
        );
      }
    }

    // ---- sample customers + bookings (tomorrow, aligned to schedules) -----
    const customers = [
      ['Rohan Iyer', 'rohan@example.com', '+91 98765 11111'],
      ['Sneha Kulkarni', 'sneha@example.com', '+91 98765 22222'],
      ['Vikram Shetty', 'vikram@example.com', '+91 98765 33333'],
    ];
    const customerIds: number[] = [];
    for (const [name, email, phone] of customers) {
      const { rows: [c] } = await client.query(
        `INSERT INTO customers (name, email, phone) VALUES ($1,$2,$3) RETURNING id`,
        [name, email, phone]
      );
      customerIds.push(c.id);
    }

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const at = (h: number, m: number) => {
      const d = new Date(tomorrow);
      d.setHours(h, m, 0, 0);
      return d;
    };
    const addMin = (d: Date, min: number) => new Date(d.getTime() + min * 60000);
    const code = () =>
      'BK-' + Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');

    // Turf 1: two evening games tomorrow; SmashPoint: one morning session
    const samples: [number, number, Date, number, number][] = [
      // providerIdx, serviceIdx, start, customerIdx, durationMin
      [4, 0, at(18, 0), 0, 60],
      [4, 1, at(20, 0), 1, 90],
      [5, 0, at(7, 0), 2, 60],
    ];
    for (const [pi, si, start, ci, dur] of samples) {
      await client.query(
        `INSERT INTO bookings (code, provider_id, service_id, customer_id, starts_at, ends_at, status, price_cents)
         VALUES ($1,$2,$3,$4,$5,$6,'confirmed',
                 (SELECT price_cents FROM services WHERE id = $3))`,
        [code(), pi + 1, serviceIds[pi][si], customerIds[ci], start, addMin(start, dur)]
      );
    }

    await client.query('COMMIT');
    console.log('✔ Seeded: 1 admin (admin@bookit.local / admin123), 6 providers, services, schedules, 3 sample bookings.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
