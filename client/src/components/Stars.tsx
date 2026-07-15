interface StarsProps {
  value: number;
  onChange?: (v: number) => void;
}

/** Read-only star row, or an interactive rating input when onChange is given. */
export function Stars({ value, onChange }: StarsProps) {
  if (!onChange) {
    return (
      <span className="stars" aria-label={`${value} out of 5 stars`}>
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`star ${i <= Math.round(value) ? 'on' : ''}`}>★</span>
        ))}
      </span>
    );
  }
  return (
    <span className="stars stars-input" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          className={`star ${i <= value ? 'on' : ''}`}
          aria-label={`${i} star${i > 1 ? 's' : ''}`}
          onClick={() => onChange(i)}
        >
          ★
        </button>
      ))}
    </span>
  );
}

/** Compact "★ 4.6 (23)" badge; renders nothing without reviews. */
export function RatingBadge({ avg, count }: { avg?: string | number | null; count?: string | number | null }) {
  const n = Number(count ?? 0);
  if (!avg || n === 0) return null;
  return (
    <span className="rating-badge">
      ★ {Number(avg).toFixed(1)} <span className="rating-count">({n})</span>
    </span>
  );
}
