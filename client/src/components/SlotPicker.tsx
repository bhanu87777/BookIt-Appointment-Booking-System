import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { addDays, fmtTime, toDateStr, WEEKDAYS_SHORT } from '../format';
import type { Provider, Slot } from '../types';

interface Props {
  provider: Provider;
  serviceId: number;
  /** Reschedule: exclude this booking's own slot from conflict checks. */
  excludeBookingId?: number;
  slot: Slot | null;
  onSelect: (s: Slot | null) => void;
  /** Bump to force a slot refetch (e.g. after a 409 conflict). */
  refreshKey?: number;
  /** Start on this date (e.g. arriving from a waitlist email). */
  initialDate?: string;
  /** Rendered under the "no slots" message (e.g. the waitlist join form). */
  renderEmpty?: (date: string) => React.ReactNode;
}

/** Date strip + grouped slot grid, shared by the booking flow and reschedule. */
export default function SlotPicker({
  provider, serviceId, excludeBookingId, slot, onSelect, refreshKey = 0, initialDate, renderEmpty,
}: Props) {
  const [date, setDate] = useState(initialDate ?? toDateStr(new Date()));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    onSelect(null);
    const exclude = excludeBookingId ? `&excludeBooking=${excludeBookingId}` : '';
    api.get<{ slots: Slot[] }>(`/api/providers/${provider.id}/slots?serviceId=${serviceId}&date=${date}${exclude}`)
      .then((r) => setSlots(r.slots))
      .catch(() => setSlots([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id, serviceId, date, excludeBookingId, refreshKey]);

  const days = useMemo(() => {
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

  return (
    <>
      <div className="date-strip">
        {days.map((d) => (
          <button
            key={d.str}
            className={`date-pill ${date === d.str ? 'selected' : ''} ${!d.open ? 'closed' : ''}`}
            onClick={() => setDate(d.str)}
          >
            <span className="date-pill-day">{WEEKDAYS_SHORT[d.date.getDay()]}</span>
            <span className="date-pill-num">{d.date.getDate()}</span>
            <span className="date-pill-month">{d.date.toLocaleString('en', { month: 'short' })}</span>
          </button>
        ))}
      </div>

      {loading && <p className="muted">Checking availability…</p>}
      {!loading && slots.length === 0 && (
        <>
          <p className="muted empty-slots">No slots available on this day — try another date.</p>
          {renderEmpty?.(date)}
        </>
      )}
      {!loading &&
        Object.entries(grouped).map(([label, list]) =>
          list.length ? (
            <div key={label} className="slot-group">
              <h4>{label}</h4>
              <div className="slot-grid">
                {list.map((s) => (
                  <button
                    key={s.start}
                    className={`slot-btn ${slot?.start === s.start ? 'selected' : ''}`}
                    onClick={() => onSelect(s)}
                  >
                    {fmtTime(s.start)}
                  </button>
                ))}
              </div>
            </div>
          ) : null
        )}
    </>
  );
}
