import { useEffect, useState } from 'react';
import { api } from '../api';
import { useCustomer } from './auth';

/** Favorite provider ids for the signed-in customer, with optimistic toggle. */
export function useFavorites() {
  const user = useCustomer();
  const [ids, setIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!user) {
      setIds(new Set());
      return;
    }
    api.get<number[]>('/api/customer/favorites/ids')
      .then((list) => setIds(new Set(list)))
      .catch(() => {});
  }, [user]);

  async function toggle(providerId: number) {
    const had = ids.has(providerId);
    setIds((s) => {
      const n = new Set(s);
      if (had) n.delete(providerId);
      else n.add(providerId);
      return n;
    });
    try {
      if (had) await api.del(`/api/customer/favorites/${providerId}`);
      else await api.put(`/api/customer/favorites/${providerId}`, {});
    } catch {
      // roll the optimistic update back
      setIds((s) => {
        const n = new Set(s);
        if (had) n.add(providerId);
        else n.delete(providerId);
        return n;
      });
    }
  }

  return { loggedIn: !!user, ids, toggle };
}
