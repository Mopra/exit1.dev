import { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/firebase';

export interface DeployMode {
  enabled: boolean;
  enabledAt: number;
  expiresAt: number;
  enabledBy: string;
  reason?: string;
  disabledAt?: number;
  disabledBy?: string;
}

export const useDeployMode = () => {
  const [deployMode, setDeployMode] = useState<DeployMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [isVisible, setIsVisible] = useState<boolean>(() => {
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible';
  });

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibility = () => {
      setIsVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  useEffect(() => {
    if (!isVisible) {
      setLoading(false);
      return;
    }

    const unsubscribe = onSnapshot(
      doc(db, 'system_settings', 'deploy_mode'),
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data() as DeployMode;
          if (data.enabled && data.expiresAt > Date.now()) {
            setDeployMode(data);
          } else {
            setDeployMode(null);
          }
        } else {
          setDeployMode(null);
        }
        setLoading(false);
      },
      () => {
        // Fail silently — deploy mode banner is non-critical
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [isVisible]);

  // Minutes remaining (updates when deployMode changes)
  const timeRemaining = deployMode
    ? Math.max(0, Math.ceil((deployMode.expiresAt - Date.now()) / 60000))
    : 0;

  return {
    isDeployMode: !!deployMode,
    deployMode,
    loading,
    timeRemaining,
  };
};
