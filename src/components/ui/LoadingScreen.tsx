import React, { useState, useEffect } from 'react';
import Spinner from './Spinner';

interface LoadingScreenProps {
  type?: 'auth' | 'module';
  message?: string;
  loadingState?: 'loading' | 'ready';
  className?: string;
}

const LoadingScreen: React.FC<LoadingScreenProps> = React.memo(({
  type = 'auth',
  message,
  loadingState = 'loading',
  className = ''
}) => {
  const [dots, setDots] = useState('');
  const [isVisible, setIsVisible] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());

  // Default messages based on type
  const defaultMessage = type === 'auth' 
    ? 'Initializing secure session' 
    : 'Loading module';

  const displayMessage = message || defaultMessage;

  // Fade in effect
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);

  // Animated dots effect
  useEffect(() => {
    const interval = setInterval(() => {
      setDots(prev => prev.length >= 3 ? '' : prev + '.');
    }, 500);

    return () => clearInterval(interval);
  }, []);

  // Step completion simulation for auth type
  useEffect(() => {
    if (type !== 'auth') return;

    const stepTimings = {
      'Connecting to authentication service': 0,
      'Initializing secure session': 400,
      'Loading user preferences': 800
    };

    const timeouts: NodeJS.Timeout[] = [];

    Object.entries(stepTimings).forEach(([step, delay]) => {
      const timeout = setTimeout(() => {
        setCompletedSteps(prev => new Set([...prev, step]));
      }, delay);
      timeouts.push(timeout);
    });

    return () => {
      timeouts.forEach(timeout => clearTimeout(timeout));
    };
  }, [loadingState, type]);

  const authSteps = [
    {
      id: 'Connecting to authentication service',
      label: 'Connecting to authentication service',
      description: 'Establishing secure connection to Clerk'
    },
    {
      id: 'Initializing secure session',
      label: 'Initializing secure session',
      description: 'Setting up Firebase authentication'
    },
    {
      id: 'Loading user preferences',
      label: 'Loading user preferences',
      description: 'Retrieving user settings and data'
    }
  ];

  // Auth loading screen (full-screen, branded)
  if (type === 'auth') {
    return (
      <div className={`min-h-screen bg-black text-white font-mono flex flex-col items-center justify-center p-8 transition-opacity duration-300 ${isVisible ? 'opacity-100' : 'opacity-0'} ${className}`}>
        <div className="text-center space-y-8 max-w-md">
          {/* Logo/Brand */}
          <div className="mb-8 animate-fade-in">
            <h1 className="text-4xl font-bold tracking-widest uppercase mb-3 text-white">
              exit1.dev
            </h1>
            <div className="text-sm opacity-60 tracking-wide font-mono">
              Website Monitoring Platform
            </div>
          </div>

          {/* Loading Animation */}
          <div className="flex flex-col items-center space-y-4">
            <div className="relative">
              <Spinner size="lg" />
            </div>
            
            <div className="text-center">
              <div className="text-base font-medium tracking-wide">
                {displayMessage}
                <span className="ml-1">{dots}</span>
              </div>
            </div>
          </div>

          {/* Status Steps */}
          <div className="text-sm space-y-2">
            {authSteps.map((step) => {
              const isCompleted = completedSteps.has(step.id);
              
              return (
                <div key={step.id} className="flex items-center justify-center space-x-2">
                  <span 
                    className={`w-2 h-2 rounded-full transition-all duration-200 ${
                      isCompleted ? 'bg-white' : 'bg-white/40'
                    }`}
                  />
                  <span className={`font-mono text-xs transition-all duration-200 ${
                      isCompleted ? 'text-white' : 'opacity-60'
                    }`}>
                    {step.label}
                  </span>
                  {isCompleted && (
                    <span className="text-white text-xs ml-1">✓</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Subtle background pattern */}
          <div className="absolute inset-0 opacity-5 pointer-events-none">
            <div className="grid grid-cols-8 grid-rows-8 h-full">
              {Array.from({ length: 64 }).map((_, i) => (
                <div key={i} className="border border-white/20"></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Module loading screen (minimal, within layout)
  return (
    <div className={`flex items-center justify-center min-h-[200px] transition-opacity duration-300 ${isVisible ? 'opacity-100' : 'opacity-0'} ${className}`}>
      <div className="font-mono text-white text-center">
        <div className="flex items-center justify-center space-x-3 mb-2">
          <Spinner size="sm" />
          <div className="text-xl tracking-widest uppercase">
            {displayMessage}
            <span className="ml-1">{dots}</span>
          </div>
        </div>
        <div className="text-sm opacity-80">→ Initializing module</div>
      </div>
    </div>
  );
});

LoadingScreen.displayName = 'LoadingScreen';

export default LoadingScreen; 