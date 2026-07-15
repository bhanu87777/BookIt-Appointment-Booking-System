import { useState } from 'react';
import { Stars } from './Stars';

interface Props {
  onSubmit: (rating: number, comment: string) => Promise<void>;
}

export default function ReviewForm({ onSubmit }: Props) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!rating) return setError('Pick a star rating first');
    setBusy(true);
    setError('');
    try {
      await onSubmit(rating, comment);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit review');
    } finally {
      setBusy(false);
    }
  }

  if (done) return <p className="flash flash-ok">Thanks for your review! ⭐</p>;

  return (
    <form onSubmit={submit} className="review-form">
      <div className="review-form-head">
        <strong>How was it?</strong>
        <Stars value={rating} onChange={setRating} />
      </div>
      <textarea
        className="input"
        rows={2}
        maxLength={2000}
        placeholder="Share a few words (optional)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      {error && <p className="error-box">{error}</p>}
      <button className="btn btn-primary btn-sm" disabled={busy}>
        {busy ? 'Submitting…' : 'Submit review'}
      </button>
    </form>
  );
}
