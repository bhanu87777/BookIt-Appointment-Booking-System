import { config } from '../config.js';

/**
 * Hand-rolled iCalendar (RFC 5545) generator — the format is small enough
 * that a dependency isn't worth it. Rules that matter for Gmail/Outlook:
 * CRLF line endings, folding of long lines, METHOD + ORGANIZER + ATTENDEE
 * present, stable UID across REQUEST/CANCEL, SEQUENCE bumped on changes.
 */
export interface IcsEvent {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  location?: string;
  sequence?: number;
  status?: 'CONFIRMED' | 'CANCELLED';
  attendee?: { name: string; email: string };
}

const pad = (n: number) => String(n).padStart(2, '0');

const icsDate = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
  `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

const esc = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** RFC 5545 §3.1: content lines over 75 octets fold with CRLF + one space. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 73) {
    out.push(rest.slice(0, 73));
    rest = ' ' + rest.slice(73);
  }
  out.push(rest);
  return out.join('\r\n');
}

/** "BookIt" <no-reply@bookit.local> -> no-reply@bookit.local */
export function organizerEmail(): string {
  const m = config.mail.from.match(/<([^>]+)>/);
  return m ? m[1] : config.mail.from;
}

export function buildIcs(events: IcsEvent[], method: 'REQUEST' | 'CANCEL'): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BookIt//Appointment Booking//EN',
    `METHOD:${method}`,
  ];
  const stamp = icsDate(new Date());
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(e.start)}`,
      `DTEND:${icsDate(e.end)}`,
      `SUMMARY:${esc(e.summary)}`,
      `SEQUENCE:${e.sequence ?? 0}`,
      `STATUS:${e.status ?? (method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED')}`,
      `ORGANIZER;CN=BookIt:mailto:${organizerEmail()}`
    );
    if (e.attendee) {
      lines.push(`ATTENDEE;CN=${esc(e.attendee.name)};RSVP=FALSE:mailto:${e.attendee.email}`);
    }
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Map a booking-detail row (getBookingDetail shape) to a VEVENT. */
export function bookingToIcsEvent(detail: any, sequence = 0, cancelled = false): IcsEvent {
  const manageUrl = `${config.clientOrigin}/manage?code=${detail.code}&email=${encodeURIComponent(detail.customer_email)}`;
  return {
    uid: `${detail.code}@bookit`,
    start: new Date(detail.starts_at),
    end: new Date(detail.ends_at),
    summary: `${detail.service_name} — ${detail.provider_name}`,
    description: `Booking code: ${detail.code}\nManage: ${manageUrl}`,
    location: detail.provider_name,
    sequence,
    status: cancelled ? 'CANCELLED' : 'CONFIRMED',
    attendee: { name: detail.customer_name, email: detail.customer_email },
  };
}
