import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtDateTime, money, STATUS_LABELS } from '../format';
import type { AdminStats, Booking } from '../types';

export default function Dashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [recent, setRecent] = useState<Booking[]>([]);

  useEffect(() => {
    api.get<AdminStats>('/api/admin/stats').then(setStats).catch(() => {});
    api.get<Booking[]>('/api/admin/bookings?limit=8').then(setRecent).catch(() => {});
  }, []);

  if (!stats) return <p className="muted">Loading dashboard…</p>;

  const cancelRate = Number(stats.created_30d)
    ? Math.round((Number(stats.cancelled_30d) / Number(stats.created_30d)) * 100)
    : 0;

  const cards = [
    { label: "Today's appointments", value: stats.today_confirmed, icon: '📅' },
    { label: 'Next 7 days', value: stats.next7_confirmed, icon: '🗓️' },
    { label: 'Revenue this month', value: money(Number(stats.month_revenue_cents)), icon: '💰' },
    { label: 'Cancel rate (30d)', value: `${cancelRate}%`, icon: '↩️' },
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
