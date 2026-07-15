import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { addDays, fmtDateTime, fmtTime, STATUS_LABELS, toDateStr, WEEKDAYS_SHORT } from '../format';
import type { Provider } from '../types';

interface WeekBooking {
  id: number;
  code: string;
  starts_at: string;
  ends_at: string;
  status: string;
  provider_id: number;
  customer_name: string;
  service_name: string;
  provider_name: string;
  color: string;
  emoji: string;
}

const HOUR_START = 6;
const HOUR_END = 23;
const PX_PER_HOUR = 44;

/** Monday of the week containing d. */
function mondayOf(d: Date): Date {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export default function WeekView() {
  const [start, setStart] = useState(() => toDateStr(mondayOf(new Date())));
  const [providerId, setProviderId] = useState('');
  const [bookings, setBookings] = useState<WeekBooking[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selected, setSelected] = useState<WeekBooking | null>(null);

  useEffect(() => {
    api.get<Provider[]>('/api/admin/providers').then(setProviders).catch(() => {});
  }, []);

  useEffect(() => {
    const q = providerId ? `&providerId=${providerId}` : '';
    api.get<WeekBooking[]>(`/api/admin/week?start=${start}${q}`)
      .then(setBookings)
      .catch(() => setBookings([]));
    setSelected(null);
  }, [start, providerId]);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(new Date(`${start}T00:00:00`), i)),
    [start]
  );
  const byDay = useMemo(() => {
    const m = new Map<string, WeekBooking[]>();
    for (const b of bookings) {
      const key = toDateStr(new Date(b.starts_at));
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(b);
    }
    return m;
  }, [bookings]);

  const top = (iso: string) => {
    const d = new Date(iso);
    return (d.getHours() + d.getMinutes() / 60 - HOUR_START) * PX_PER_HOUR;
  };
  const height = (b: WeekBooking) =>
    ((new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 3600000) * PX_PER_HOUR;

  const shift = (weeks: number) => setStart(toDateStr(addDays(new Date(`${start}T00:00:00`), weeks * 7)));
  const gridH = (HOUR_END - HOUR_START) * PX_PER_HOUR;
  const todayKey = toDateStr(new Date());

  return (
    <div>
      <div className="dayview-head">
        <h1 className="admin-title">Week view</h1>
        <div className="btn-row">
          <select className="input" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">All providers</option>
            {providers.filter((p) => p.active).map((p) => (
              <option key={p.id} value={p.id}>{p.emoji} {p.name}</option>
            ))}
          </select>
          <button className="btn btn-ghost" onClick={() => shift(-1)}>← Prev</button>
          <button className="btn btn-ghost" onClick={() => setStart(toDateStr(mondayOf(new Date())))}>Today</button>
          <button className="btn btn-ghost" onClick={() => shift(1)}>Next →</button>
        </div>
      </div>

      {selected && (
        <div className="panel week-popover">
          <div className="panel-head">
            <h2>
              <span className="mini-avatar" style={{ background: selected.color }}>{selected.emoji}</span>{' '}
              {selected.service_name} · <span className="mono">{selected.code}</span>
            </h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>✕</button>
          </div>
          <p>
            {selected.customer_name} with {selected.provider_name} ·{' '}
            {fmtDateTime(selected.starts_at)} – {fmtTime(selected.ends_at)} ·{' '}
            <span className={`badge badge-${selected.status}`}>{STATUS_LABELS[selected.status] ?? selected.status}</span>
          </p>
          <Link className="panel-link" to={`/admin/bookings?search=${selected.code}`}>
            Open in bookings →
          </Link>
        </div>
      )}

      <div className="panel timeline-panel">
        <div className="timeline" style={{ gridTemplateColumns: `64px repeat(7, minmax(120px, 1fr))` }}>
          <div className="tl-corner" />
          {days.map((d) => {
            const key = toDateStr(d);
            return (
              <div key={key} className={`tl-provider-head week-day-head ${key === todayKey ? 'is-today' : ''}`}>
                <span>{WEEKDAYS_SHORT[d.getDay()]}</span>
                <strong>{d.getDate()}</strong>
                <span className="muted small">{d.toLocaleString('en', { month: 'short' })}</span>
              </div>
            );
          })}
          <div className="tl-hours" style={{ height: gridH }}>
            {Array.from({ length: HOUR_END - HOUR_START }, (_, i) => (
              <div key={i} className="tl-hour" style={{ height: PX_PER_HOUR }}>
                {String(HOUR_START + i).padStart(2, '0')}:00
              </div>
            ))}
          </div>
          {days.map((d) => {
            const key = toDateStr(d);
            return (
              <div key={key} className="tl-col" style={{ height: gridH }}>
                {Array.from({ length: HOUR_END - HOUR_START }, (_, i) => (
                  <div key={i} className="tl-gridline" style={{ top: i * PX_PER_HOUR }} />
                ))}
                {(byDay.get(key) ?? []).map((b) => (
                  <button
                    key={b.id}
                    className={`tl-booking tl-clickable ${b.status === 'pending_payment' ? 'tl-pending' : ''}`}
                    style={{ top: top(b.starts_at), height: Math.max(height(b) - 2, 18), borderLeftColor: b.color }}
                    title={`${b.code} — ${b.customer_name} (${b.service_name})`}
                    onClick={() => setSelected(b)}
                  >
                    <strong>{fmtTime(b.starts_at)}</strong> {b.customer_name}
                    <div className="tl-service">{b.service_name}</div>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        {bookings.length === 0 && <p className="muted center pad">No bookings this week.</p>}
      </div>
    </div>
  );
}
