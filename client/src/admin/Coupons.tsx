import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { money } from '../format';
import type { Coupon } from '../types';

const empty = {
  code: '', type: 'percent' as Coupon['type'], value: 10, max_uses: null as number | null,
  min_amount_cents: 0, valid_from: null as string | null, valid_to: null as string | null, active: true,
};

export default function Coupons() {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [editing, setEditing] = useState<(typeof empty & { id?: number }) | null>(null);
  const [error, setError] = useState('');

  const load = () => api.get<Coupon[]>('/api/admin/coupons').then(setCoupons).catch(() => {});
  useEffect(() => {
    void load();
  }, []);

  async function save() {
    if (!editing) return;
    setError('');
    try {
      if (editing.id) await api.put(`/api/admin/coupons/${editing.id}`, editing);
      else await api.post('/api/admin/coupons', editing);
      setEditing(null);
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.details ? ' — ' + err.details.join('; ') : ''}` : String(err));
    }
  }

  return (
    <>
      <div className="admin-title-row">
        <h1 className="admin-title">Coupons</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing({ ...empty })}>+ New coupon</button>
      </div>

      <div className="panel">
        {coupons.length === 0 && <p className="muted">No coupons yet.</p>}
        {coupons.length > 0 && (
          <table className="table">
            <thead>
              <tr><th>Code</th><th>Discount</th><th>Min order</th><th>Uses</th><th>Valid</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {coupons.map((c) => (
                <tr key={c.id} className={c.active ? '' : 'row-hidden'}>
                  <td className="mono">{c.code}</td>
                  <td>{c.type === 'percent' ? `${c.value}% off` : `${money(c.value)} off`}</td>
                  <td>{c.min_amount_cents ? money(c.min_amount_cents) : '—'}</td>
                  <td>{c.used_count}{c.max_uses ? ` / ${c.max_uses}` : ''}</td>
                  <td className="small">
                    {c.valid_from ? new Date(c.valid_from).toLocaleDateString('en-IN') : '…'} →{' '}
                    {c.valid_to ? new Date(c.valid_to).toLocaleDateString('en-IN') : '…'}
                  </td>
                  <td><span className={`badge ${c.active ? 'badge-confirmed' : 'badge-cancelled'}`}>{c.active ? 'Active' : 'Inactive'}</span></td>
                  <td className="row-actions">
                    <button className="btn btn-ghost btn-xs" onClick={() => setEditing({
                      id: c.id, code: c.code, type: c.type, value: c.value, max_uses: c.max_uses,
                      min_amount_cents: c.min_amount_cents, valid_from: c.valid_from, valid_to: c.valid_to, active: c.active,
                    })}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {editing && (
          <div className="service-editor">
            <h3>{editing.id ? `Edit: ${editing.code}` : 'New coupon'}</h3>
            <div className="form-grid">
              <label>Code
                <input className="input" value={editing.code} placeholder="WELCOME10"
                  onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })} />
              </label>
              <label>Type
                <select className="input" value={editing.type}
                  onChange={(e) => setEditing({ ...editing, type: e.target.value as Coupon['type'] })}>
                  <option value="percent">Percent off</option>
                  <option value="fixed">Fixed amount off</option>
                </select>
              </label>
              <label>{editing.type === 'percent' ? 'Percent (1–100)' : 'Amount (₹)'}
                <input className="input" type="number" min={1}
                  value={editing.type === 'percent' ? editing.value : editing.value / 100}
                  onChange={(e) => setEditing({
                    ...editing,
                    value: editing.type === 'percent' ? +e.target.value : Math.round(+e.target.value * 100),
                  })} />
              </label>
              <label>Max uses (blank = unlimited)
                <input className="input" type="number" min={1} value={editing.max_uses ?? ''}
                  onChange={(e) => setEditing({ ...editing, max_uses: e.target.value ? +e.target.value : null })} />
              </label>
              <label>Min order (₹)
                <input className="input" type="number" min={0} value={editing.min_amount_cents / 100}
                  onChange={(e) => setEditing({ ...editing, min_amount_cents: Math.round(+e.target.value * 100) })} />
              </label>
              <label>Valid from
                <input className="input" type="date" value={editing.valid_from?.slice(0, 10) ?? ''}
                  onChange={(e) => setEditing({ ...editing, valid_from: e.target.value || null })} />
              </label>
              <label>Valid to
                <input className="input" type="date" value={editing.valid_to?.slice(0, 10) ?? ''}
                  onChange={(e) => setEditing({ ...editing, valid_to: e.target.value || null })} />
              </label>
              <label className="check-label">
                <input type="checkbox" checked={editing.active}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Active
              </label>
            </div>
            {error && <p className="error-box">{error}</p>}
            <div className="btn-row">
              <button className="btn btn-primary" onClick={save}>Save coupon</button>
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
