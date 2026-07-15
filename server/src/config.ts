import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/appointments',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-prod',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  mail: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM ?? '"BookIt" <no-reply@bookit.local>',
  },
  payments: {
    provider: (process.env.PAYMENT_PROVIDER ?? 'mock') as 'mock',
    holdMinutes: Number(process.env.PAYMENT_HOLD_MINUTES ?? 10),
    mockSecret: process.env.MOCK_PAY_SECRET ?? 'mockpay-dev-secret',
  },
  refundPolicy: {
    fullBeforeHours: Number(process.env.REFUND_FULL_BEFORE_HOURS ?? 24),
    feePct: Number(process.env.REFUND_FEE_PCT ?? 25),
    noneWithinHours: Number(process.env.REFUND_NONE_WITHIN_HOURS ?? 2),
  },
};
