/**
 * Hand-rolled SVG/CSS chart primitives — no chart library by design.
 * One metric per chart (never dual axes); single hue per chart via the
 * --chart-* tokens; identity lives in labels, never color alone.
 */

interface BarDatum {
  label: string;      // axis tick (sparse)
  tooltip: string;    // full hover text
  value: number;
}

const niceMax = (n: number) => {
  if (n <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (n <= m * mag) return m * mag;
  return 10 * mag;
};

/** Vertical bar chart: thin bars, rounded data-ends, hairline grid, native tooltips. */
export function BarChart({ data, color, valueFmt, height = 180 }: {
  data: BarDatum[];
  color: string;      // a --chart-* CSS variable reference
  valueFmt: (v: number) => string;
  height?: number;
}) {
  const W = 720;
  const PAD_L = 44;
  const PAD_B = 20;
  const plotW = W - PAD_L - 8;
  const plotH = height - PAD_B - 8;
  const max = niceMax(Math.max(...data.map((d) => d.value), 1));
  const bw = plotW / Math.max(data.length, 1);
  const barW = Math.max(2, Math.min(22, bw - 2));
  const gridYs = [0.25, 0.5, 0.75, 1];
  const tickEvery = Math.ceil(data.length / 8);

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img">
      {gridYs.map((g) => {
        const y = 8 + plotH * (1 - g);
        return (
          <g key={g}>
            <line className="chart-grid" x1={PAD_L} x2={W - 8} y1={y} y2={y} />
            <text className="chart-tick" x={PAD_L - 6} y={y + 3} textAnchor="end">
              {valueFmt(max * g)}
            </text>
          </g>
        );
      })}
      <line className="chart-axis" x1={PAD_L} x2={W - 8} y1={8 + plotH} y2={8 + plotH} />
      {data.map((d, i) => {
        const h = Math.round((d.value / max) * plotH);
        const x = PAD_L + i * bw + (bw - barW) / 2;
        const y = 8 + plotH - h;
        return (
          <g key={i}>
            {/* hit target wider than the mark */}
            <rect x={PAD_L + i * bw} y={8} width={bw} height={plotH} fill="transparent">
              <title>{`${d.tooltip}: ${valueFmt(d.value)}`}</title>
            </rect>
            {d.value > 0 && (
              <rect
                className="chart-bar"
                x={x} y={y} width={barW} height={h}
                rx={Math.min(3, barW / 2)}
                fill={color}
                pointerEvents="none"
              />
            )}
            {i % tickEvery === 0 && (
              <text className="chart-tick" x={PAD_L + i * bw + bw / 2} y={height - 4} textAnchor="middle">
                {d.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Weekday × hour demand heatmap: CSS grid, one-hue lightness ramp, max labeled. */
export function Heatmap({ cells }: { cells: { dow: number; hour: number; count: number }[] }) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hours = Array.from({ length: 17 }, (_, i) => i + 6); // 06:00–22:00
  const byKey = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c.count]));
  const max = Math.max(...cells.map((c) => c.count), 1);

  return (
    <div className="heatmap" style={{ gridTemplateColumns: `36px repeat(${hours.length}, 1fr)` }}>
      <span />
      {hours.map((h) => (
        <span key={h} className="heatmap-tick">{h % 3 === 0 ? `${h}` : ''}</span>
      ))}
      {DAYS.map((day, dow) => (
        <div key={day} className="heatmap-row">
          <span className="heatmap-day">{day}</span>
          {hours.map((h) => {
            const count = byKey.get(`${dow}:${h}`) ?? 0;
            const pct = count === 0 ? 0 : 15 + Math.round((count / max) * 85);
            return (
              <div
                key={h}
                className="heatmap-cell"
                style={{ background: `color-mix(in srgb, var(--chart-volume) ${pct}%, var(--surface))` }}
                title={`${day} ${String(h).padStart(2, '0')}:00 — ${count} booking${count === 1 ? '' : 's'}${count === max ? ' (peak)' : ''}`}
              >
                {count === max && max > 0 ? <span className="heatmap-peak">{count}</span> : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Horizontal bars with direct value labels; identity in the row label. */
export function HBarList({ items, valueFmt }: {
  items: { label: string; sub?: string; dotColor?: string; value: number }[];
  valueFmt: (v: number) => string;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="hbar-list">
      {items.map((it, i) => (
        <div key={i} className="hbar-row" title={`${it.label}: ${valueFmt(it.value)}`}>
          <div className="hbar-label">
            {it.dotColor && <span className="hbar-dot" style={{ background: it.dotColor }} />}
            <span className="hbar-name">{it.label}</span>
            {it.sub && <span className="muted small">{it.sub}</span>}
          </div>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${Math.max((it.value / max) * 100, 1)}%` }} />
            <span className="hbar-value">{valueFmt(it.value)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
