import nodemailer from 'nodemailer';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

const OUTBOX = path.resolve('outbox');

const transporter = config.mail.host
  ? nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.port === 465,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    })
  : nodemailer.createTransport({ jsonTransport: true }); // dev fallback

const money = (cents: number) => `₹${(cents / 100).toLocaleString('en-IN')}`;
const fmt = (d: string | Date) =>
  new Date(d).toLocaleString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });

function layout(title: string, accent: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;padding:32px 16px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,.08)">
    <div style="background:${accent};padding:28px 32px;color:#fff">
      <div style="font-size:13px;letter-spacing:2px;opacity:.85">BOOKIT</div>
      <h1 style="margin:6px 0 0;font-size:22px">${title}</h1>
    </div>
    <div style="padding:28px 32px;color:#334155;font-size:15px;line-height:1.6">${body}</div>
    <div style="padding:18px 32px;background:#f8fafc;color:#94a3b8;font-size:12px">
      This is an automated message from BookIt — Appointment Booking System.
    </div>
  </div></body></html>`;
}

function detailTable(b: any) {
  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 0;color:#64748b;width:130px">${k}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`;
  return `<table style="width:100%;border-collapse:collapse;margin:16px 0">
    ${row('Booking code', `<span style="font-family:monospace;font-size:16px">${b.code}</span>`)}
    ${row('Provider', `${b.emoji ?? ''} ${b.provider_name}`)}
    ${row('Service', b.service_name)}
    ${row('When', fmt(b.starts_at) + ' – ' + new Date(b.ends_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }))}
    ${row('Price', money(b.price_cents))}
  </table>`;
}

async function deliver(to: string, subject: string, html: string, bookingId?: number) {
  try {
    const info = await transporter.sendMail({ from: config.mail.from, to, subject, html });
    if (!config.mail.host) {
      // dev mode: drop the rendered email into ./outbox so it can be inspected
      mkdirSync(OUTBOX, { recursive: true });
      const file = path.join(OUTBOX, `${Date.now()}-${subject.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.html`);
      writeFileSync(file, html);
      console.log(`📧 [dev outbox] ${subject} -> ${to}  (${file})`);
    }
    if (bookingId) {
      await pool.query(
        `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1,'email_sent','system',$2)`,
        [bookingId, subject]
      );
    }
    return info;
  } catch (err: any) {
    console.error(`Email delivery failed (${subject} -> ${to}):`, err.message);
  }
}

export function sendConfirmationEmail(b: any) {
  const manageUrl = `${config.clientOrigin}/manage?code=${b.code}&email=${encodeURIComponent(b.customer_email)}`;
  const html = layout('Booking confirmed ✔', '#16a34a', `
    <p>Hi ${b.customer_name},</p>
    <p>Your appointment is <strong>confirmed</strong>. Here are the details:</p>
    ${detailTable(b)}
    <a href="${manageUrl}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600">View / cancel booking</a>
    <p style="margin-top:20px;color:#64748b;font-size:13px">Need to reschedule? Cancel and book a new slot from the link above.</p>`);
  return deliver(b.customer_email, `Confirmed: ${b.service_name} on ${fmt(b.starts_at)} [${b.code}]`, html, b.id);
}

export function sendCancellationEmail(b: any, cancelledBy: 'you' | 'the provider') {
  const html = layout('Booking cancelled', '#dc2626', `
    <p>Hi ${b.customer_name},</p>
    <p>The following booking was cancelled by <strong>${cancelledBy}</strong>. The slot has been released.</p>
    ${detailTable(b)}
    <a href="${config.clientOrigin}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600">Book a new slot</a>`);
  return deliver(b.customer_email, `Cancelled: ${b.service_name} on ${fmt(b.starts_at)} [${b.code}]`, html, b.id);
}
