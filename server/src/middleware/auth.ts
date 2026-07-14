import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface AdminClaims {
  sub: number;
  email: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      admin?: AdminClaims;
    }
  }
}

export function signAdminToken(claims: AdminClaims) {
  return jwt.sign(claims, config.jwtSecret, { expiresIn: '12h' });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.admin = jwt.verify(token, config.jwtSecret) as unknown as AdminClaims;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
