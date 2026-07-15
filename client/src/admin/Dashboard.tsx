import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtDateTime, money, STATUS_LABELS } from '../format';
import type { AdminStats, Booking } from '../types';
import { BarChart, Heatmap, HBarList } from './charts';

interface Analytics {
  days: number;
  timeseries: { day: string; bookings: number; revenue_cents: number; cancelled: number }[];
  heatmap: { dow: number; hour: number; count: number }[];
  services: { id: number; name: string; provider_name: string; color: string; emoji: string; bookings: number; revenue_cents: number }[];
  statusRates: { status: string; count: number }[];
  customers: { new_bookings: number; returning_bookings: number; new_customers: number };
}

const dayTick = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const dayFull = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const compactMoney = (v: number) =>
  v >= 100000_00 ? `₹${(v / 100000_00).toFixed(1)}L` : v >= 1000_00 ? `₹${Math.round(v / 1000_00)}k` : `₹${Math.round(v / 100)}`;

export default function Dashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [recent, setRecent] = useState<Booking[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    api.get<AdminStats>('/api/admin/stats').then(setStats).catch(() => {});
    api.get<Booking[]>('/api/admin/bookings?limit=8').then(setRecent).catch(() => {});
  }, []);

  useEffect(() => {
    api.get<Analytics>(`/api/admin/analytics?days=${days}`).then(setAnalytics).catch(() => {});
  }, [days]);

  if (!stats) return <p className="muted">Loading dashboard…</p>;

  const cancelRate = Number(stats.created_30d)
    ? Math.round((Number(stats.cancelled_30d) / Number(stats.created_30d)) * 100)
    : 0;

  const cards = [
    { label: "Today's appointments", value: stats.today_confirmed, icon: '📅' },
    { label: 'Next 7 days', value: stats.next7_confirmed, icon: '🗓️' },
    { label: 'Booked value (month)', value: money(Number(stats.month_revenue_cents)), icon: '💰' },
    { label: 'Collected online (month)', value: money(Number(stats.month_collected_cents ?? 0)), icon: '💳' },
    { label: 'Refunded (month)', value: money(Number(stats.month_refunded_cents ?? 0)), icon: '↩️' },
    { label: 'Cancel rate (30d)', value: `${cancelRate}%`, icon: '📉' },
    { label: 'Active providers', value: stats.active_providers, icon: '👥' },
    { label: 'Customers', value: stats.customers, icon: '🙋' },
  ];

  return (
    <div>
      <h1 className="admin-title">Dashboard</h1>
      <div className="stat-grid">
        {cards.map((c) => (
          <div key={c.label} className="stat-card">
            <span className="stat-icon">{c.icon}</span>
            <div>
              <div className="stat-value">{c.value}</div>
              <div className="stat-label">{c.label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="admin-title-row">
        <h2 className="analytics-title">Analytics</h2>
        <div className="range-tabs">
          {[7, 30, 90].map((d) => (
            <button key={d} className={`tab ${days === d ? 'active' : ''}`} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </div>

      {analytics && (
        <>
          <div className="dash-cols">
            <section className="panel">
              <h2>Bookings per day</h2>
              <BarChart
                color="var(--chart-volume)"
                valueFmt={(v) => String(Math.round(v))}
                data={analytics.timeseries.map((t) => ({
                  label: dayTick(t.day), tooltip: dayFull(t.day), value: t.bookings,
                }))}
              />
            </section>
            <section className="panel">
              <h2>Net revenue per day</h2>
              <BarChart
                color="var(--chart-revenue)"
                valueFmt={compactMoney}
                data={analytics.timeseries.map((t) => ({
                  label: dayTick(t.day), tooltip: dayFull(t.day), value: t.revenue_cents,
                }))}
              />
            </section>
          </div>

          <section className="panel">
            <h2>Peak hours (weekday × hour)</h2>
            <Heatmap cells={analytics.heatmap} />
          </section>

          <div className="dash-cols">
            <section className="panel">
              <h2>Top services by revenue</h2>
              {analytics.services.length === 0 && <p className="muted">No bookings in this window.</p>}
              <HBarList
                valueFmt={(v) => money(v)}
                items={analytics.services.map((s) => ({
                  label: s.name,
                  sub: `${s.emoji} ${s.provider_name} · ${s.bookings}×`,
                  dotColor: s.color,
                  value: s.revenue_cents,
                }))}
              />
            </section>
            <section className="panel">
              <h2>Outcomes & customers ({analytics.days}d)</h2>
              <div className="status-rows">
                {analytics.statusRates.map((s) => {
                  const total = analytics.statusRates.reduce((sum, x) => sum + x.count, 0);
                  return (
                    <div key={s.status} className="status-row">
                      <span className={`badge badge-${s.status}`}>{STATUS_LABELS[s.status] ?? s.status}</span>
                      <div className="hbar-track">
                        <div
                          className="hbar-fill"
                          style={{
                            width: `${Math.max((s.count / Math.max(total, 1)) * 100, 1)}%`,
                            background: s.status === 'cancelled' || s.status === 'no_show'
                              ? 'var(--chart-danger)'
                              : 'var(--chart-volume)',
                          }}
                        />
                        <span className="hbar-value">
                          {s.count} ({Math.round((s.count / Math.max(total, 1)) * 100)}%)
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="stat-grid mini-stats">
                <div className="stat-card"><span className="stat-icon">🆕</span><div>
                  <div className="stat-value">{analytics.customers.new_bookings}</div>
                  <div className="stat-label">Bookings from new customers</div>
                </div></div>
                <div className="stat-card"><span className="stat-icon">🔁</span><div>
                  <div className="stat-value">{analytics.customers.returning_bookings}</div>
                  <div className="stat-label">From returning customers</div>
                </div></div>
              </div>
            </section>
          </div>
        </>
      )}

      <div className="dash-cols">
        <section className="panel">
          <h2>Providers — upcoming load</h2>
          <table className="table">
            <thead><tr><th>Provider</th><th>Upcoming</th><th>Revenue (month)</th></tr></thead>
            <tbody>
              {stats.byProvider.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/admin/providers/${p.id}`} className="cell-provider">
                      <span className="mini-avatar" style={{ background: p.color }}>{p.emoji}</span>
                      {p.name}
                    </Link>
                  </td>
                  <td>{p.upcoming}</td>
                  <td>{money(Number(p.month_revenue_cents))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h2>Recent bookings</h2>
          <table className="table">
            <thead><tr><th>Code</th><th>Customer</th><th>When</th><th>Status</th></tr></thead>
            <tbody>
              {recent.map((b) => (
                <tr key={b.id}>
                  <td className="mono">{b.code}</td>
                  <td>{b.customer_name}</td>
                  <td>{fmtDateTime(b.starts_at)}</td>
                  <td><span className={`badge badge-${b.status}`}>{STATUS_LABELS[b.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Link to="/admin/bookings" className="panel-link">All bookings →</Link>
        </section>
      </div>
    </div>
  );
}
