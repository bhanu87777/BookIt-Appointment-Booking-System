import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { fmtTime, hhmm, money, WEEKDAYS, WEEKDAYS_SHORT } from '../format';
import type { Booking, Provider, Service, Slot } from '../types';
import { useCustomer } from '../customer/auth';
import { useFavorites } from '../customer/favorites';
import SlotPicker from '../components/SlotPicker';
import WaitlistForm from '../components/WaitlistForm';
import { RatingBadge, Stars } from '../components/Stars';

interface Review {
  rating: number;
  comment: string;
  created_at: string;
  customer_name: string;
  service_name: string;
}

export default function ProviderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const user = useCustomer();

  const [provider, setProvider] = useState<Provider | null>(null);
  const [service, setService] = useState<Service | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [form, setForm] = useState({ name: user?.name ?? '', email: user?.email ?? '', phone: '', notes: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [reviews, setReviews] = useState<Review[]>([]);
  const fav = useFavorites();

  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState<{ code: string; discountCents: number } | null>(null);
  const [couponMsg, setCouponMsg] = useState('');
  const [pointsBalance, setPointsBalance] = useState(0);
  const [redeemPoints, setRedeemPoints] = useState(0);
  const [repeat, setRepeat] = useState<'once' | 'weekly' | 'biweekly'>('once');
  const [occurrences, setOccurrences] = useState(4);

  useEffect(() => {
    if (!user) return;
    api.get<{ points_balance: number }>('/api/customer/me')
      .then((me) => setPointsBalance(me.points_balance))
      .catch(() => {});
  }, [user]);

  const [params] = useSearchParams();

  useEffect(() => {
    api.get<Provider>(`/api/providers/${id}`).then((p) => {
      setProvider(p);
      // deep links (waitlist emails) preselect the service
      const wanted = Number(params.get('serviceId'));
      const preselect = wanted ? p.services?.find((s) => s.id === wanted) : undefined;
      if (preselect) setService(preselect);
      else if (p.services?.length === 1) setService(p.services[0]);
    });
    api.get<Review[]>(`/api/providers/${id}/reviews`).then(setReviews).catch(() => setReviews([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // pricing preview (server recomputes authoritatively inside the booking txn)
  const couponDiscount = coupon?.discountCents ?? 0;
  const pointsDiscount = redeemPoints * 100;
  const netCents = service ? Math.max(0, service.price_cents - couponDiscount - pointsDiscount) : 0;
  const maxRedeem = service
    ? Math.max(0, Math.min(pointsBalance, Math.floor((service.price_cents - couponDiscount) * 0.5 / 100)))
    : 0;
  const dueNowCents = !service || service.payment_policy === 'none' || !service.payment_policy
    ? 0
    : service.payment_policy === 'full'
      ? netCents
      : Math.max(Math.ceil((netCents * (service.deposit_pct ?? 50)) / 100), 100);

  async function applyCoupon() {
    if (!service || !couponInput.trim()) return;
    setCouponMsg('');
    try {
      const r = await api.post<{ valid: boolean; code?: string; discountCents?: number; reason?: string }>(
        '/api/coupons/validate',
        { code: couponInput.trim(), serviceId: service.id }
      );
      if (r.valid) {
        setCoupon({ code: r.code!, discountCents: r.discountCents! });
        setCouponMsg(`Coupon ${r.code} applied — you save ${money(r.discountCents!)}`);
      } else {
        setCoupon(null);
        setCouponMsg(r.reason ?? 'Invalid coupon');
      }
    } catch (err) {
      setCoupon(null);
      setCouponMsg(err instanceof Error ? err.message : 'Could not validate coupon');
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!provider || !service || !slot) return;
    setSubmitting(true);
    setError('');
    try {
      if (repeat !== 'once') {
        const result = await api.post<{ series: { code: string }; booked: Booking[]; skipped: { start: string; reason: string }[] }>(
          '/api/bookings/series',
          {
            providerId: provider.id,
            serviceId: service.id,
            start: slot.start,
            customer: { name: form.name, email: form.email, phone: form.phone || undefined },
            notes: form.notes || undefined,
            frequency: repeat,
            occurrences,
          }
        );
        navigate('/confirmation', { state: { booking: result.booked[0], series: result } });
        return;
      }
      const booking = await api.post<Booking>('/api/bookings', {
        providerId: provider.id,
        serviceId: service.id,
        start: slot.start,
        customer: { name: form.name, email: form.email, phone: form.phone || undefined },
        notes: form.notes || undefined,
        couponCode: coupon?.code,
        redeemPoints: redeemPoints > 0 ? redeemPoints : undefined,
      });
      if (booking.payment) {
        navigate(`/checkout/${booking.code}`, { state: { booking } });
      } else {
        navigate('/confirmation', { state: { booking } });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(err.message + ' The slot list has been refreshed.');
        setSlot(null);
        setRefreshKey((k) => k + 1);
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
        {fav.loggedIn && (
          <button
            className={`fav-btn ${fav.ids.has(provider.id) ? 'on' : ''}`}
            title={fav.ids.has(provider.id) ? 'Remove from favorites' : 'Add to favorites'}
            onClick={() => fav.toggle(provider.id)}
          >
            {fav.ids.has(provider.id) ? '♥' : '♡'}
          </button>
        )}
        <div className="provider-avatar lg" style={{ background: provider.color }}>{provider.emoji}</div>
        <h1>{provider.name}</h1>
        <p className="provider-title">{provider.title} <RatingBadge avg={provider.avg_rating} count={provider.review_count} /></p>
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
            <SlotPicker
              provider={provider}
              serviceId={service.id}
              slot={slot}
              onSelect={setSlot}
              refreshKey={refreshKey}
              initialDate={params.get('date') ?? undefined}
              renderEmpty={(date) => (
                <WaitlistForm providerId={provider.id} serviceId={service.id} date={date} />
              )}
            />
          </div>
        )}

        {service && slot && (
          <div className="step-card">
            <h2><span className="step-num">3</span> Your details</h2>
            <div className="summary-bar">
              {service.name} · {new Date(slot.start).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
              {' '}at {fmtTime(slot.start)} · {money(netCents)}
              {(couponDiscount > 0 || pointsDiscount > 0) && (
                <s className="summary-strike">{money(service.price_cents)}</s>
              )}
              {dueNowCents > 0 && dueNowCents < netCents && (
                <span className="summary-due"> · pay {money(dueNowCents)} now</span>
              )}
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
              {(service.payment_policy ?? 'none') === 'none' && (
                <div className="form-row">
                  <label>
                    Repeat
                    <select className="input" value={repeat}
                      onChange={(e) => setRepeat(e.target.value as typeof repeat)}>
                      <option value="once">Just once</option>
                      <option value="weekly">Weekly</option>
                      <option value="biweekly">Every 2 weeks</option>
                    </select>
                  </label>
                  {repeat !== 'once' && (
                    <label>
                      Number of sessions (2–12)
                      <input className="input" type="number" min={2} max={12} value={occurrences}
                        onChange={(e) => setOccurrences(Math.max(2, Math.min(12, +e.target.value || 2)))} />
                    </label>
                  )}
                </div>
              )}
              {repeat !== 'once' && (
                <p className="muted small">
                  Sessions repeat at the same time {repeat === 'weekly' ? 'every week' : 'every two weeks'}.
                  Dates that are unavailable or outside the booking window are skipped and reported.
                </p>
              )}
              <div className="form-row">
                <label>
                  Coupon code
                  <div className="coupon-row">
                    <input className="input" value={couponInput} placeholder="e.g. WELCOME10"
                      onChange={(e) => setCouponInput(e.target.value)} />
                    <button type="button" className="btn btn-ghost" onClick={applyCoupon}>Apply</button>
                  </div>
                  {couponMsg && <span className={`small ${coupon ? 'coupon-ok' : 'coupon-bad'}`}>{couponMsg}</span>}
                </label>
                {user && pointsBalance > 0 && (
                  <label>
                    Redeem points (you have {pointsBalance} = {money(pointsBalance * 100)})
                    <input className="input" type="number" min={0} max={maxRedeem} value={redeemPoints || ''}
                      placeholder={maxRedeem > 0 ? `up to ${maxRedeem}` : 'not available'}
                      disabled={maxRedeem === 0}
                      onChange={(e) => setRedeemPoints(Math.max(0, Math.min(maxRedeem, +e.target.value || 0)))} />
                  </label>
                )}
              </div>
              {error && <p className="error-box">{error}</p>}
              <button className="btn btn-primary btn-lg" disabled={submitting}>
                {submitting
                  ? 'Booking…'
                  : repeat !== 'once'
                    ? `Book ${occurrences} sessions — ${money(service.price_cents)} each`
                    : dueNowCents > 0
                      ? `Pay ${money(dueNowCents)} & book`
                      : `Confirm booking — ${money(netCents)}`}
              </button>
              {dueNowCents > 0 && dueNowCents < netCents && (
                <p className="muted small">
                  {money(dueNowCents)} deposit now · {money(netCents - dueNowCents)} at the venue.
                </p>
              )}
            </form>
          </div>
        )}

        {reviews.length > 0 && (
          <div className="step-card">
            <h2>⭐ Reviews</h2>
            <div className="review-list">
              {reviews.map((r, i) => (
                <div key={i} className="review-item">
                  <div className="review-item-head">
                    <Stars value={r.rating} />
                    <strong>{r.customer_name}</strong>
                    <span className="muted small">
                      {r.service_name} · {new Date(r.created_at).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}
                    </span>
                  </div>
                  {r.comment && <p className="review-comment">{r.comment}</p>}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
