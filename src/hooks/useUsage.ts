import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useNanoPlan } from './useNanoPlan';

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
  const { nano } = useNanoPlan();
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
      const emailData = (emailRes.data as any)?.data as EmailUsage | undefined;

      // Only fetch SMS usage for Nano users (free users have 0 SMS limit)
      let smsData: SmsUsage | null = null;
      if (nano) {
        const smsRes = await getSmsUsageFn({ clientTier: 'nano' });
        smsData = (smsRes.data as any)?.data as SmsUsage | undefined ?? null;
      }

      setUsage({
        email: emailData ?? null,
        sms: smsData,
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to load usage');
    } finally {
      setLoading(false);
    }
  }, [userId, nano]);

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
