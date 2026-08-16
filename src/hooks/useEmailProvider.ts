import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/firebase';
import type { EmailProviderSettingsDoc } from '@/api/types';

/**
 * Subscribes to `system_settings/email_provider` — the switch that decides
 * whether transactional email leaves via Resend or Day3.
 *
 * Unlike heartbeat_defer, nothing listens to this doc live: Cloud Functions
 * and both VPS runners poll it behind a 30s TTL cache. So the value here is
 * what senders will pick up within ~30 seconds, not necessarily what the
 * in-flight send is using. `POST /admin/refresh-flags` on a runner closes
 * that gap when it matters.
 *
 * Returns `settings: null` while the first snapshot is in flight. A missing
 * doc means the default: everything on Resend.
 */
export const DEFAULT_EMAIL_PROVIDER: EmailProviderSettingsDoc = {
  provider: 'resend',
  categories: {},
  canaryPercent: 0,
  fallbackToResend: true,
};

export const useEmailProvider = () => {
  const [settings, setSettings] = useState<EmailProviderSettingsDoc | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      doc(db, 'system_settings', 'email_provider'),
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data() as EmailProviderSettingsDoc;
          setSettings({
            ...DEFAULT_EMAIL_PROVIDER,
            ...data,
            categories: data.categories ?? {},
          });
        } else {
          setSettings(DEFAULT_EMAIL_PROVIDER);
        }
        setLoading(false);
      },
      () => setLoading(false),
    );
    return () => unsubscribe();
  }, []);

  return { settings, loading };
};
