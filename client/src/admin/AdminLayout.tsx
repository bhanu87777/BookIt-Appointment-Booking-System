import { useEffect } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { clearToken, getToken } from '../api';
import ThemeToggle from '../components/ThemeToggle';

export default function AdminLayout() {
  const navigate = useNavigate();
  const user = JSON.parse(localStorage.getItem('bookit_admin_user') ?? 'null');

  useEffect(() => {
    if (!getToken()) navigate('/admin/login');
  }, [navigate]);

  function logout() {
    clearToken();
    localStorage.removeItem('bookit_admin_user');
    navigate('/admin/login');
  }

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <Link to="/" className="brand admin-brand">📅 Book<span className="brand-accent">It</span></Link>
        <nav>
          <NavLink to="/admin" end>📊 Dashboard</NavLink>
          <NavLink to="/admin/bookings">🗓️ Bookings</NavLink>
          <NavLink to="/admin/day">⏱️ Day view</NavLink>
          <NavLink to="/admin/week">📆 Week view</NavLink>
          <NavLink to="/admin/providers">👥 Providers</NavLink>
          <NavLink to="/admin/reviews">⭐ Reviews</NavLink>
          <NavLink to="/admin/payments">💳 Payments</NavLink>
          <NavLink to="/admin/coupons">🏷️ Coupons</NavLink>
          <NavLink to="/admin/waitlist">🔔 Waitlist</NavLink>
          <NavLink to="/admin/customers">🙋 Customers</NavLink>
        </nav>
        <div className="admin-user">
          <span>{user?.email ?? ''}</span>
          <div className="btn-row">
            <button className="btn btn-ghost btn-sm" onClick={logout}>Sign out</button>
            <ThemeToggle />
          </div>
        </div>
      </aside>
      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
