import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { computeSlots } from './slots.js';
import { enqueue } from './notify/outbox.js';
import { wake } from './notify/dispatcher.js';
import { setWaitlistHook } from './booking.js';
import { extraRenderers, layout } from './notify/templates.js';

export interface JoinWaitlistInput {
  providerId: number;
  serviceId: number;
  date: string; // YYYY-MM-DD
  customer: { name: string; email: string; phone?: string };
}

export async function joinWaitlist(input: JoinWaitlistInput) {
  // abuse guard: the waitlist is only for genuinely full days
  const { slots } = await computeSlots(pool, input.providerId, input.serviceId, input.date);
  if (slots.length > 0) {
    throw Object.assign(new Error('Slots are still available on this day — pick one instead'), { status: 400 });
  }
  await pool.query(
    `INSERT INTO waitlist (provider_id, service_id, date, name, email, phone)
     VALUES ($1, $2, $3, $4, lower($5), $6)
     ON CONFLICT DO NOTHING`,
    [input.providerId, input.serviceId, input.date,
     input.customer.name.trim(), input.customer.email.trim(), input.customer.phone?.trim() ?? '']
  );
  return { ok: true };
}

const localDateStr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Called by cancelBooking after a slot frees up. Notifies the top 3 waiting
 * entries for that provider+day (same-service first, then FIFO) — first to
 * rebook wins the slot. FOR UPDATE SKIP LOCKED + the status flip inside one
 * transaction make each entry claimable exactly once even when two
 * cancellations land simultaneously.
 */
async function onSlotFreed(booking: any) {
  const starts = new Date(booking.starts_at);
  if (starts <= new Date()) return;
  const dateStr = localDateStr(starts);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: entries } = await client.query(
      `SELECT w.*, p.name AS provider_name, s.name AS service_name
       FROM waitlist w
       JOIN providers p ON p.id = w.provider_id
       JOIN services s ON s.id = w.service_id
       WHERE w.provider_id = $1 AND w.date = $2::date AND w.status = 'waiting'
       ORDER BY (w.service_id = $3) DESC, w.created_at ASC
       LIMIT 3
       FOR UPDATE OF w SKIP LOCKED`,
      [booking.provider_id, dateStr, booking.service_id]
    );
    for (const w of entries) {
      await client.query(`UPDATE waitlist SET status = 'notified', notified_at = now() WHERE id = $1`, [w.id]);
      await enqueue(client, {
        waitlistId: w.id,
        template: 'waitlist_slot_open',
        recipient: w.email,
        payload: {
          name: w.name,
          providerName: w.provider_name,
          serviceName: w.service_name,
          providerId: w.provider_id,
          serviceId: w.service_id,
          date: dateStr,
        },
      });
    }
    await client.query('COMMIT');
    if (entries.length) wake();
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('[waitlist] notify failed:', err.message);
  } finally {
    client.release();
  }
}

setWaitlistHook(onSlotFreed);

extraRenderers.waitlist_slot_open = (payload) => {
  const day = new Date(`${payload.date}T00:00:00`).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const bookUrl = `${config.clientOrigin}/provider/${payload.providerId}?serviceId=${payload.serviceId}&date=${payload.date}`;
  const html = layout('A slot just opened up! 🎉', '#16a34a', `
    <p>Hi ${payload.name},</p>
    <p>Good news — a slot for <strong>${payload.serviceName}</strong> with
       <strong>${payload.providerName}</strong> on <strong>${day}</strong> just became available.</p>
    <p>Slots go to whoever books first, so grab it while it lasts:</p>
    <a href="${bookUrl}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600">Book the slot</a>`);
  return { subject: `Slot open: ${payload.serviceName} with ${payload.providerName} on ${day}`, html };
};
