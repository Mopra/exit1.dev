import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { usePlan } from './usePlan';

type UsageWindow = {
  count: number;
  max: number;
  windowStart: number;
  windowEnd: number;
};

type EmailUsage = {
  hourly: UsageWindow;
  monthly: UsageWindow;
};

type SmsUsage = {
  hourly: UsageWindow;
  monthly: UsageWindow;
};

export type Usage = {
  email: EmailUsage | null;
  sms: SmsUsage | null;
};

// Create Firebase callable references outside hook to avoid recreating on every call
// This prevents unnecessary function invocations
const functions = getFunctions();
const getEmailUsageFn = httpsCallable(functions, 'getEmailUsage');
const getSmsUsageFn = httpsCallable(functions, 'getSmsUsage');

export function useUsage() {
  const { userId } = useAuth();
  const { pro } = usePlan();
  const [usage, setUsage] = useState<Usage>({ email: null, sms: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    if (!userId) {
      setUsage({ email: null, sms: null });
      setLoading(false);
      return;
    }

    try {
      setError(null);

      // Fetch email usage for everyone
      const emailRes = await getEmailUsageFn({});
      const emailData = (emailRes.data as { data?: EmailUsage })?.data;

      // SMS quota lookup is gated to Pro+ on the backend (TIER_LIMITS.smsAlerts).
      let smsData: SmsUsage | null = null;
      if (pro) {
        const smsRes = await getSmsUsageFn({});
        smsData = (smsRes.data as { data?: SmsUsage })?.data ?? null;
      }

      setUsage({
        email: emailData ?? null,
        sms: smsData,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load usage');
    } finally {
      setLoading(false);
    }
  }, [userId, pro]);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  // Refresh usage data
  const refresh = useCallback(() => {
    setLoading(true);
    fetchUsage();
  }, [fetchUsage]);

  return { usage, loading, error, refresh };
}
