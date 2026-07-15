import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface AdminClaims {
  sub: number;
  email: string;
  name: string;
  kind: 'admin';
}

export interface CustomerClaims {
  sub: number;
  email: string;
  name: string;
  kind: 'customer';
}

declare global {
  namespace Express {
    interface Request {
      admin?: AdminClaims;
      customer?: CustomerClaims;
    }
  }
}

export function signAdminToken(claims: Omit<AdminClaims, 'kind'>) {
  return jwt.sign({ ...claims, kind: 'admin' }, config.jwtSecret, { expiresIn: '12h' });
}

export function signCustomerToken(claims: Omit<CustomerClaims, 'kind'>) {
  return jwt.sign({ ...claims, kind: 'customer' }, config.jwtSecret, { expiresIn: '30d' });
}

/** Verify the Bearer token, if any. Returns the payload or null. */
function verifyBearer(req: Request): any | null {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

// Both token kinds share one signing secret, so every guard must check `kind` —
// otherwise a customer token would open the admin API.
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const payload = verifyBearer(req);
  if (!payload || payload.kind !== 'admin') {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.admin = payload as AdminClaims;
  next();
}

export function requireCustomer(req: Request, res: Response, next: NextFunction) {
  const payload = verifyBearer(req);
  if (!payload || payload.kind !== 'customer') {
    return res.status(401).json({ error: 'Sign in to continue' });
  }
  req.customer = payload as CustomerClaims;
  next();
}

/** Attaches req.customer when a valid customer token is present; never rejects. */
export function optionalCustomer(req: Request, _res: Response, next: NextFunction) {
  const payload = verifyBearer(req);
  if (payload && payload.kind === 'customer') req.customer = payload as CustomerClaims;
  next();
}
