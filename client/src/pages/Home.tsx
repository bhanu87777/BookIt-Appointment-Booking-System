import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { BusinessTypeInfo } from '../types';

export default function Home() {
  const [types, setTypes] = useState<BusinessTypeInfo[]>([]);

  useEffect(() => {
    api.get<BusinessTypeInfo[]>('/api/business-types').then(setTypes).catch(() => {});
  }, []);

  return (
    <div className="container">
      <section className="hero">
        <h1>
          Book anything.<br />
          <span className="hero-accent">Doctors, salons &amp; turfs.</span>
        </h1>
        <p className="hero-sub">
          Real-time availability, zero double-bookings, instant email confirmations.
          Pick a category to get started.
        </p>
      </section>

      <section className="category-grid">
        {types.map((t) => (
          <Link key={t.key} to={`/browse/${t.key}`} className={`category-card cat-${t.key}`}>
            <span className="category-emoji">{t.emoji}</span>
            <h2>{t.label}</h2>
            <p>{t.tagline}</p>
            <span className="category-cta">Browse →</span>
          </Link>
        ))}
      </section>

      <section className="feature-strip">
        <div className="feature">
          <span>⚡</span>
          <div>
            <h3>Live slot availability</h3>
            <p>Slots are computed from real schedules, breaks and existing bookings.</p>
          </div>
        </div>
        <div className="feature">
          <span>🔒</span>
          <div>
            <h3>Conflict-proof</h3>
            <p>Database-level exclusion constraints make double-booking impossible.</p>
          </div>
        </div>
        <div className="feature">
          <span>📧</span>
          <div>
            <h3>Email confirmations</h3>
            <p>Instant confirmation and cancellation emails with a manage link.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
