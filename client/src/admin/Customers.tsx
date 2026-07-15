import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtDate, money } from '../format';

export interface CrmCustomer {
  id: number;
  name: string;
  email: string;
  phone: string;
  created_at: string;
  has_account: boolean;
  points_balance: number;
  booking_count: number;
  total_spend_cents: number;
  last_visit: string | null;
  no_show_count: number;
  upcoming: number;
}

export default function Customers() {
  const [customers, setCustomers] = useState<CrmCustomer[]>([]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('recent');

  useEffect(() => {
    const t = setTimeout(() => {
      const q = new URLSearchParams({ sort });
      if (search) q.set('search', search);
      api.get<CrmCustomer[]>(`/api/admin/customers?${q}`).then(setCustomers).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [search, sort]);

  return (
    <>
      <h1 className="admin-title">Customers</h1>
      <div className="filter-bar">
        <input className="input" placeholder="Search name / email / phone…"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="recent">Most recent visit</option>
          <option value="spend">Highest spend</option>
          <option value="bookings">Most bookings</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>

      <div className="panel">
        {customers.length === 0 && <p className="muted">No customers found.</p>}
        {customers.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th><th>Bookings</th><th>Spend</th><th>Points</th>
                <th>Last visit</th><th>No-shows</th><th>Upcoming</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/admin/customers/${c.id}`}>
                      <strong>{c.name}</strong> {c.has_account && <span title="Has an account">👤</span>}
                    </Link>
                    <div className="muted small">{c.email}{c.phone ? ` · ${c.phone}` : ''}</div>
                  </td>
                  <td>{c.booking_count}</td>
                  <td>{money(c.total_spend_cents)}</td>
                  <td>{c.points_balance}</td>
                  <td className="small">{c.last_visit ? fmtDate(c.last_visit) : '—'}</td>
                  <td>
                    {c.no_show_count > 0
                      ? <span className="badge badge-no_show">{c.no_show_count}</span>
                      : <span className="muted">0</span>}
                  </td>
                  <td>{c.upcoming}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
