import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { customerRouter } from './routes/customer.js';
import { paymentsRouter } from './routes/payments.js';
import { errorHandler } from './middleware/errors.js';
import { pool } from './db/pool.js';
import { startDispatcher, stopDispatcher } from './services/notify/dispatcher.js';
import { startSweeper, stopSweeper } from './services/sweeper.js';

const app = express();

app.use(cors({ origin: config.clientOrigin }));
app.use(express.json());

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

app.use('/api', publicRouter);
app.use('/api/admin', adminRouter);
app.use('/api/customer', customerRouter);
app.use('/api/payments', paymentsRouter);
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`🚀 API listening on http://localhost:${config.port}`);
  startDispatcher();
  startSweeper();
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopDispatcher();
    stopSweeper();
    process.exit(0);
  });
}
