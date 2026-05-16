import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/firebase';

/**
 * Subscribes to `system_settings/heartbeat_defer`. The VPS also listens
 * to this doc — flipping the value here propagates to both regions
 * within seconds.
 *
 * Returns `enabled: null` while the initial snapshot is in flight so
 * consumers can distinguish "loading" from "explicitly off". The doc
 * may simply not exist (initial state); that case resolves to `false`.
 */
export interface HeartbeatDeferState {
  enabled: boolean;
  updatedAt?: number;
  updatedBy?: string;
}

export const useHeartbeatDefer = () => {
  const [state, setState] = useState<HeartbeatDeferState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      doc(db, 'system_settings', 'heartbeat_defer'),
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data() as HeartbeatDeferState;
          setState({ ...data, enabled: !!data.enabled });
        } else {
          setState({ enabled: false });
        }
        setLoading(false);
      },
      () => setLoading(false),
    );
    return () => unsubscribe();
  }, []);

  return {
    enabled: state?.enabled ?? null,
    state,
    loading,
  };
};
