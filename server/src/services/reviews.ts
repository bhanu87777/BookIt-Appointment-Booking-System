import { pool } from '../db/pool.js';

/**
 * Insert a review for a booking (already ownership-verified by the caller).
 * Returns null when the booking was already reviewed.
 */
export async function submitReview(booking: any, rating: number, comment: string) {
  if (booking.status !== 'completed') {
    throw Object.assign(new Error('Only completed bookings can be reviewed'), { status: 400 });
  }
  // provider/customer ids come from the booking row, never from client input
  const { rows: [review] } = await pool.query(
    `INSERT INTO reviews (booking_id, provider_id, customer_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (booking_id) DO NOTHING
     RETURNING *`,
    [booking.id, booking.provider_id, booking.customer_id, rating, comment.trim()]
  );
  if (review) {
    await pool.query(
      `INSERT INTO booking_events (booking_id, event, actor, detail) VALUES ($1, 'reviewed', 'customer', $2)`,
      [booking.id, `${rating}★`]
    );
  }
  return review ?? null;
}
