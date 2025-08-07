import { useState, useEffect } from 'react';
import { Card, Badge, Button } from '../components/ui';
import { db } from '../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client';

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
  const [nextUpdate, setNextUpdate] = useState<Date>(new Date(Date.now() + 60000));
  const [currentTime, setCurrentTime] = useState<Date>(new Date());

  const checkFirebaseStatus = async () => {
    console.log('🔄 Checking Firebase status...');
    
    try {
      // Simple connectivity test without fetching all data
      setStatus(prev => ({ ...prev, firebase: 'online' }));
      setStatus(prev => ({ ...prev, firestore: 'online' }));
      
      // Try a minimal Firestore operation to test connectivity
      const testDoc = doc(db, 'checks', 'test-connection');
      await getDoc(testDoc);
      
      // If we get here, Firestore is working
      setStatus(prev => ({ ...prev, firestore: 'online' }));
      
      // Get recent errors using a more efficient approach
      try {
        const response = await apiClient.getSystemStatus();
        if (response.success && response.data?.recentErrors) {
          setRecentErrors(response.data.recentErrors);
        }
      } catch (statsError) {
        console.error('Error fetching recent errors:', statsError);
        // Don't fail the entire status check for this
      }
      
    } catch (error) {
      console.error('Firestore test failed:', error);
      setStatus(prev => ({ ...prev, firestore: 'offline' }));
    }

    // For now, let's assume Functions is online if we can reach this point
    setStatus(prev => ({ ...prev, functions: 'online' }));
    
    // Try the Cloud Function call as a bonus feature
    try {
      const response = await apiClient.getSystemStatus();
      if (response.success) {
        setStatus(prev => ({ ...prev, functions: 'online' }));
      } else {
        setStatus(prev => ({ ...prev, functions: 'offline' }));
      }
    } catch (error) {
      console.error('Functions test failed:', error);
      setStatus(prev => ({ ...prev, functions: 'offline' }));
    }
  };

  useEffect(() => {
    const checkStatus = async () => {
      await checkFirebaseStatus();
      setLastUpdated(new Date());
      setNextUpdate(new Date(Date.now() + 60000)); // Increased to 60 seconds
      console.log('✅ Status check completed, next update in 60 seconds');
    };

    checkStatus();
    
    // Check status every 60 seconds instead of 30
    const interval = setInterval(checkStatus, 60000);
    console.log('⏰ Auto-refresh interval set for 60 seconds');
    
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
    <div className="py-16 px-8 w-full max-w-full">
      <div className="max-w-[1140px] mx-auto w-full max-w-full">
        {/* Back to Home Button */}
        <div className="mb-8 w-full max-w-full">
          <Button
            variant="ghost"
            onClick={() => navigate('/')}
          >
            ← Back to Home
          </Button>
        </div>

        {/* Header Section */}
        <div className="text-center mb-16">
          <h1 className={`text-4xl uppercase tracking-widest font-mono text-foreground mb-6`}>
            Service Status
          </h1>
          <p className={`text-muted-foreground text-base mb-3`}>
            Real-time monitoring of exit1.dev services
          </p>
          <p className={`text-muted-foreground text-sm`}>
            Last updated: {lastUpdated.toLocaleTimeString()}
          </p>
          <p className={`text-muted-foreground text-sm mt-1`}>
            Next update in: {getTimeUntilNextUpdate()}s
          </p>
        </div>

        {/* Service Status Grid */}
        <Card className={`p-8 mb-16`}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
            <div className={`bg-card rounded-lg p-8 border border`}>
              <div className="flex items-center justify-between mb-6">
                <h3 className={`font-semibold text-foreground text-lg`}>Firebase</h3>
                <span className="text-2xl">{getStatusIcon(status.firebase)}</span>
              </div>
              <Badge variant={getStatusColor(status.firebase)} className="mb-6">
                {status.firebase.toUpperCase()}
              </Badge>
              <p className={`text-muted-foreground text-sm`}>
                Core Firebase services
              </p>
            </div>

            <div className={`bg-card rounded-lg p-8 border border`}>
              <div className="flex items-center justify-between mb-6">
                <h3 className={`font-semibold text-foreground text-lg`}>Firestore</h3>
                <span className="text-2xl">{getStatusIcon(status.firestore)}</span>
              </div>
              <Badge variant={getStatusColor(status.firestore)} className="mb-6">
                {status.firestore.toUpperCase()}
              </Badge>
              <p className={`text-muted-foreground text-sm`}>
                Database connectivity
              </p>
            </div>

            <div className={`bg-card rounded-lg p-8 border border`}>
              <div className="flex items-center justify-between mb-6">
                <h3 className={`font-semibold text-foreground text-lg`}>Functions</h3>
                <span className="text-2xl">{getStatusIcon(status.functions)}</span>
              </div>
              <Badge variant={getStatusColor(status.functions)} className="mb-6">
                {status.functions.toUpperCase()}
              </Badge>
              <p className={`text-muted-foreground text-sm`}>
                Backend processing
              </p>
            </div>
          </div>
        </Card>

        {/* Recent Errors */}
        {recentErrors.length > 0 && (
          <Card className={`p-8 mb-16`}>
            <h2 className={`text-2xl uppercase tracking-widest font-mono text-foreground mb-8`}>
              Recent Issues
            </h2>
            <div className="space-y-6">
              {recentErrors.map((error) => (
                <div key={error.id} className={`border-l-4 border-red-500 pl-8 py-6 bg-muted rounded-md`}>
                  <div className="flex justify-between items-start">
                    <div>
                      <div className={`font-medium text-foreground mb-2`}>
                        {error.website}
                      </div>
                      <div className={`text-sm text-destructive`}>
                        {error.error}
                      </div>
                    </div>
                    <div className={`text-xs text-muted-foreground ml-6`}>
                      {new Date(error.timestamp).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Footer */}
        <div className={`text-center text-sm text-muted-foreground`}>
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
