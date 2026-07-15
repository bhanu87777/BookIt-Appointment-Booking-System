import { useSyncExternalStore } from 'react';
import { clearCustomerToken, getCustomerToken, setCustomerToken } from '../api';

export interface CustomerUser {
  sub: number;
  email: string;
  name: string;
}

const USER_KEY = 'bookit_customer_user';

let listeners: (() => void)[] = [];
const emit = () => listeners.forEach((l) => l());

// snapshot must be referentially stable between changes for useSyncExternalStore
let cached: { raw: string | null; user: CustomerUser | null } = { raw: null, user: null };

function snapshot(): CustomerUser | null {
  const raw = getCustomerToken() ? localStorage.getItem(USER_KEY) : null;
  if (raw !== cached.raw) {
    let user: CustomerUser | null = null;
    try {
      user = raw ? (JSON.parse(raw) as CustomerUser) : null;
    } catch {
      user = null;
    }
    cached = { raw, user };
  }
  return cached.user;
}

export function setSession(token: string, user: CustomerUser) {
  setCustomerToken(token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  emit();
}

export function clearSession() {
  clearCustomerToken();
  localStorage.removeItem(USER_KEY);
  emit();
}

export function getUser(): CustomerUser | null {
  return snapshot();
}

export function useCustomer(): CustomerUser | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    },
    snapshot
  );
}
