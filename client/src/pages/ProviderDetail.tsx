import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { addDays, fmtTime, hhmm, money, toDateStr, WEEKDAYS, WEEKDAYS_SHORT } from '../format';
import type { Booking, Provider, Service, Slot } from '../types';

export default function ProviderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [provider, setProvider] = useState<Provider | null>(null);
  const [service, setService] = useState<Service | null>(null);
  const [date, setDate] = useState(toDateStr(new Date()));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<Provider>(`/api/providers/${id}`).then((p) => {
      setProvider(p);
      if (p.services?.length === 1) setService(p.services[0]);
    });
  }, [id]);

  useEffect(() => {
    if (!provider || !service) return;
    setSlotsLoading(true);
    setSlot(null);
    api.get<{ slots: Slot[] }>(`/api/providers/${provider.id}/slots?serviceId=${service.id}&date=${date}`)
      .then((r) => setSlots(r.slots))
      .catch(() => setSlots([]))
      .finally(() => setSlotsLoading(false));
  }, [provider, service, date]);

  const days = useMemo(() => {
    if (!provider) return [];
    const openWeekdays = new Set((provider.schedules ?? []).map((s) => s.weekday));
    return Array.from({ length: Math.min(provider.booking_horizon_days, 14) }, (_, i) => {
      const d = addDays(new Date(), i);
      return { date: d, str: toDateStr(d), open: openWeekdays.has(d.getDay()) };
    });
  }, [provider]);

  const grouped = useMemo(() => {
    const g: Record<string, Slot[]> = { Morning: [], Afternoon: [], Evening: [] };
    for (const s of slots) {
      const h = new Date(s.start).getHours();
      (h < 12 ? g.Morning : h < 17 ? g.Afternoon : g.Evening).push(s);
    }
    return g;
  }, [slots]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!provider || !service || !slot) return;
    setSubmitting(true);
    setError('');
    try {
      const booking = await api.post<Booking>('/api/bookings', {
        providerId: provider.id,
        serviceId: service.id,
        start: slot.start,
        customer: { name: form.name, email: form.email, phone: form.phone || undefined },
        notes: form.notes || undefined,
      });
      navigate('/confirmation', { state: { booking } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(err.message + ' The slot list has been refreshed.');
        setSlot(null);
        const r = await api.get<{ slots: Slot[] }>(
          `/api/providers/${provider.id}/slots?serviceId=${service.id}&date=${date}`
        );
        setSlots(r.slots);
      } else {
        setError(err instanceof Error ? err.message : 'Booking failed');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!provider) return <div className="container"><p className="muted">Loading…</p></div>;

  return (
    <div className="container detail-layout">
      {/* ---- provider card ---- */}
      <aside className="detail-side">
        <div className="provider-avatar lg" style={{ background: provider.color }}>{provider.emoji}</div>
        <h1>{provider.name}</h1>
        <p className="provider-title">{provider.title}</p>
        <p className="provider-bio">{provider.bio}</p>
        <div className="hours-box">
          <h3>Weekly hours</h3>
          {WEEKDAYS.map((day, wd) => {
            const windows = (provider.schedules ?? []).filter((s) => s.weekday === wd);
            return (
              <div key={wd} className="hours-row">
                <span>{WEEKDAYS_SHORT[wd]}</span>
                <span>
                  {windows.length
                    ? windows.map((w) => `${hhmm(w.start_time)}–${hhmm(w.end_time)}`).join(', ')
                    : <em className="muted">Closed</em>}
                </span>
              </div>
            );
          })}
        </div>
      </aside>

      {/* ---- booking flow ---- */}
      <section className="detail-main">
        <div className="step-card">
          <h2><span className="step-num">1</span> Choose a service</h2>
          <div className="service-list">
            {(provider.services ?? []).map((s) => (
              <button
                key={s.id}
                className={`service-option ${service?.id === s.id ? 'selected' : ''}`}
                onClick={() => setService(s)}
              >
                <div>
                  <strong>{s.name}</strong>
                  <p>{s.description}</p>
                </div>
                <div className="service-meta">
                  <span className="service-price">{money(s.price_cents)}</span>
                  <span className="service-duration">{s.duration_min} min</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {service && (
          <div className="step-card">
            <h2><span className="step-num">2</span> Pick a date &amp; time</h2>
            <div className="date-strip">
              {days.map((d) => (
                <button
                  key={d.str}
                  className={`date-pill ${date === d.str ? 'selected' : ''} ${!d.open ? 'closed' : ''}`}
                  onClick={() => setDate(d.str)}
                >
                  <span className="date-pill-day">{WEEKDAYS_SHORT[d.date.getDay()]}</span>
                  <span className="date-pill-num">{d.date.getDate()}</span>
                  <span className="date-pill-month">
                    {d.date.toLocaleString('en', { month: 'short' })}
                  </span>
                </button>
              ))}
            </div>

            {slotsLoading && <p className="muted">Checking availability…</p>}
            {!slotsLoading && slots.length === 0 && (
              <p className="muted empty-slots">No slots available on this day — try another date.</p>
            )}
            {!slotsLoading &&
              Object.entries(grouped).map(([label, list]) =>
                list.length ? (
                  <div key={label} className="slot-group">
                    <h4>{label}</h4>
                    <div className="slot-grid">
                      {list.map((s) => (
                        <button
                          key={s.start}
                          className={`slot-btn ${slot?.start === s.start ? 'selected' : ''}`}
                          onClick={() => setSlot(s)}
                        >
                          {fmtTime(s.start)}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null
              )}
          </div>
        )}

        {service && slot && (
          <div className="step-card">
            <h2><span className="step-num">3</span> Your details</h2>
            <div className="summary-bar">
              {service.name} · {new Date(slot.start).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
              {' '}at {fmtTime(slot.start)} · {money(service.price_cents)}
            </div>
            <form onSubmit={submit} className="booking-form">
              <div className="form-row">
                <label>
                  Full name *
                  <input className="input" required minLength={2} value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </label>
                <label>
                  Email *
                  <input className="input" type="email" required value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </label>
              </div>
              <div className="form-row">
                <label>
                  Phone
                  <input className="input" value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </label>
                <label>
                  Notes for the provider
                  <input className="input" value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </label>
              </div>
              {error && <p className="error-box">{error}</p>}
              <button className="btn btn-primary btn-lg" disabled={submitting}>
                {submitting ? 'Booking…' : `Confirm booking — ${money(service.price_cents)}`}
              </button>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}
