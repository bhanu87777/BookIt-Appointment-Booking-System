import { Link, NavLink, Outlet } from 'react-router-dom';
import ThemeToggle from './ThemeToggle';
import { useCustomer } from '../customer/auth';

export default function Layout() {
  const user = useCustomer();
  return (
    <div className="site">
      <header className="site-header">
        <div className="container header-row">
          <Link to="/" className="brand">
            <span className="brand-mark">📅</span> Book<span className="brand-accent">It</span>
          </Link>
          <nav className="site-nav">
            <NavLink to="/browse/doctor">Doctors</NavLink>
            <NavLink to="/browse/salon">Salons</NavLink>
            <NavLink to="/browse/turf">Turfs</NavLink>
            <NavLink to="/manage" className="nav-pill">Manage booking</NavLink>
            {user ? (
              <NavLink to="/account" className="nav-pill">👤 {user.name.split(' ')[0]}</NavLink>
            ) : (
              <NavLink to="/account/login" className="nav-pill">Sign in</NavLink>
            )}
            <ThemeToggle />
          </nav>
        </div>
      </header>
      <main className="site-main">
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="container footer-row">
          <span>BookIt — Appointment Booking System</span>
          <Link to="/admin">Admin panel →</Link>
        </div>
      </footer>
    </div>
  );
}
