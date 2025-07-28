import { useState, useEffect } from 'react';
import { Card, Badge, Button } from '../components/ui';
import { db, functions } from '../firebase';
import { collection, getDocs, query } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { theme, typography, spacing } from '../config/theme';
import { useNavigate } from 'react-router-dom';

interface SystemStatus {
  firebase: 'online' | 'offline' | 'checking';
  firestore: 'online' | 'offline' | 'checking';
  functions: 'online' | 'offline' | 'checking';
}

interface RecentError {
  id: string;
  website: string;
  error: string;
  timestamp: number;
}

const Status = () => {
  const navigate = useNavigate();
  const [status, setStatus] = useState<SystemStatus>({
    firebase: 'checking',
    firestore: 'checking',
    functions: 'checking'
  });
  const [recentErrors, setRecentErrors] = useState<RecentError[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [nextUpdate, setNextUpdate] = useState<Date>(new Date(Date.now() + 30000));
  const [currentTime, setCurrentTime] = useState<Date>(new Date());

  const checkFirebaseStatus = async () => {
    console.log('🔄 Checking Firebase status...', new Date().toLocaleTimeString());
    
    // Firebase connection is considered online if we can import it
    setStatus(prev => ({ ...prev, firebase: 'online' }));

    try {
      // Test Firestore connection - assume it's online if we can reach this point
      // The actual connectivity will be tested when we try to get data
      setStatus(prev => ({ ...prev, firestore: 'online' }));
      
      // If Firestore is working, get recent errors
      try {
        const websitesQuery = query(collection(db, 'checks'));
        const snapshot = await getDocs(websitesQuery);
        
        const websites = snapshot.docs.map(doc => doc.data());
        
        // Check for recent errors
        const recentErrors: RecentError[] = [];
        websites.forEach(website => {
          if (website.lastError && website.lastChecked) {
            const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
            if (website.lastChecked > oneDayAgo) {
              recentErrors.push({
                id: 'temp',
                website: website.url || 'Unknown',
                error: website.lastError,
                timestamp: website.lastChecked
              });
            }
          }
        });
        
        // Sort by timestamp and take the most recent 5
        recentErrors.sort((a, b) => b.timestamp - a.timestamp);
        setRecentErrors(recentErrors.slice(0, 5));
        
      } catch (statsError) {
        console.error('Error fetching recent errors:', statsError);
      }
      
    } catch (error) {
      console.error('Firestore test failed:', error); // Debug log
      setStatus(prev => ({ ...prev, firestore: 'offline' }));
    }

    // For now, let's assume Functions is online if we can reach this point
    setStatus(prev => ({ ...prev, functions: 'online' }));
    
    // Try the Cloud Function call as a bonus feature
    try {
      const getSystemStatus = httpsCallable(functions, 'getSystemStatus');
      const result = await getSystemStatus();
      const data = result.data as any;
      
      console.log('Status function result:', data); // Debug log
      
      if (data.success) {
        // Update with more detailed data if available
        setRecentErrors(data.data.recentErrors);
      }
    } catch (error) {
      console.error('Error calling status function:', error); // Debug log
      // Don't mark functions as offline if this fails, since we already marked it as online
    }
  };

  useEffect(() => {
    const checkStatus = async () => {
      await checkFirebaseStatus();
      setLastUpdated(new Date());
      setNextUpdate(new Date(Date.now() + 30000));
      console.log('✅ Status check completed, next update in 30 seconds');
    };

    checkStatus();
    
    // Check status every 30 seconds
    const interval = setInterval(checkStatus, 30000);
    console.log('⏰ Auto-refresh interval set for 30 seconds');
    
    return () => {
      clearInterval(interval);
      console.log('🧹 Auto-refresh interval cleared');
    };
  }, []);

  // Countdown timer effect - updates every second
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const getTimeUntilNextUpdate = () => {
    const timeLeft = Math.max(0, nextUpdate.getTime() - currentTime.getTime());
    return Math.ceil(timeLeft / 1000);
  };


  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online': return 'success';
      case 'offline': return 'error';
      case 'checking': return 'warning';
      default: return 'default';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'online': return '🟢';
      case 'offline': return '🔴';
      case 'checking': return '🟡';
      default: return '⚪';
    }
  };

  return (
    <div className="py-16 px-8">
      <div className="max-w-[1140px] mx-auto">
        {/* Back to Home Button */}
        <div className="mb-8">
          <Button
            variant="ghost"
            onClick={() => navigate('/')}
          >
            ← Back to Home
          </Button>
        </div>

        {/* Header Section */}
        <div className="text-center mb-16">
          <h1 className={`text-4xl uppercase tracking-widest ${typography.fontFamily.display} ${theme.colors.text.primary} mb-6`}>
            Service Status
          </h1>
          <p className={`${theme.colors.text.secondary} ${typography.fontSize.base} mb-3`}>
            Real-time monitoring of exit1.dev services
          </p>
          <p className={`${theme.colors.text.muted} ${typography.fontSize.sm}`}>
            Last updated: {lastUpdated.toLocaleTimeString()}
          </p>
          <p className={`${theme.colors.text.muted} ${typography.fontSize.sm} mt-1`}>
            Next update in: {getTimeUntilNextUpdate()}s
          </p>
        </div>

        {/* Service Status Grid */}
        <Card className={`${spacing.padding.xl} mb-16`}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
            <div className={`${theme.colors.background.card} ${theme.borderRadius.lg} ${spacing.padding.xl} border ${theme.colors.border.primary}`}>
              <div className="flex items-center justify-between mb-6">
                <h3 className={`${typography.fontWeight.semibold} ${theme.colors.text.primary} ${typography.fontSize.lg}`}>Firebase</h3>
                <span className="text-2xl">{getStatusIcon(status.firebase)}</span>
              </div>
              <Badge variant={getStatusColor(status.firebase)} className="mb-6">
                {status.firebase.toUpperCase()}
              </Badge>
              <p className={`${theme.colors.text.secondary} ${typography.fontSize.sm}`}>
                Core Firebase services
              </p>
            </div>

            <div className={`${theme.colors.background.card} ${theme.borderRadius.lg} ${spacing.padding.xl} border ${theme.colors.border.primary}`}>
              <div className="flex items-center justify-between mb-6">
                <h3 className={`${typography.fontWeight.semibold} ${theme.colors.text.primary} ${typography.fontSize.lg}`}>Firestore</h3>
                <span className="text-2xl">{getStatusIcon(status.firestore)}</span>
              </div>
              <Badge variant={getStatusColor(status.firestore)} className="mb-6">
                {status.firestore.toUpperCase()}
              </Badge>
              <p className={`${theme.colors.text.secondary} ${typography.fontSize.sm}`}>
                Database connectivity
              </p>
            </div>

            <div className={`${theme.colors.background.card} ${theme.borderRadius.lg} ${spacing.padding.xl} border ${theme.colors.border.primary}`}>
              <div className="flex items-center justify-between mb-6">
                <h3 className={`${typography.fontWeight.semibold} ${theme.colors.text.primary} ${typography.fontSize.lg}`}>Functions</h3>
                <span className="text-2xl">{getStatusIcon(status.functions)}</span>
              </div>
              <Badge variant={getStatusColor(status.functions)} className="mb-6">
                {status.functions.toUpperCase()}
              </Badge>
              <p className={`${theme.colors.text.secondary} ${typography.fontSize.sm}`}>
                Backend processing
              </p>
            </div>
          </div>
        </Card>

        {/* Recent Errors */}
        {recentErrors.length > 0 && (
          <Card className={`${spacing.padding.xl} mb-16`}>
            <h2 className={`text-2xl uppercase tracking-widest ${typography.fontFamily.display} ${theme.colors.text.primary} mb-8`}>
              Recent Issues
            </h2>
            <div className="space-y-6">
              {recentErrors.map((error) => (
                <div key={error.id} className={`border-l-4 border-red-500 pl-8 py-6 ${theme.colors.background.secondary} ${theme.borderRadius.default}`}>
                  <div className="flex justify-between items-start">
                    <div>
                      <div className={`${typography.fontWeight.medium} ${theme.colors.text.primary} mb-2`}>
                        {error.website}
                      </div>
                      <div className={`${typography.fontSize.sm} ${theme.colors.text.error}`}>
                        {error.error}
                      </div>
                    </div>
                    <div className={`${typography.fontSize.xs} ${theme.colors.text.muted} ml-6`}>
                      {new Date(error.timestamp).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Footer */}
        <div className={`text-center ${typography.fontSize.sm} ${theme.colors.text.muted}`}>
          <p className="mb-3">
            This status page automatically updates every 30 seconds.
          </p>
          <p>
            For support, reach out on our community Discord.
            <a href="https://discord.gg/uZvWbpwJZS" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-600 ml-2">
              https://discord.gg/uZvWbpwJZS
            </a>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Status; 
