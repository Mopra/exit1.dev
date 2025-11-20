import React from 'react';
import { Skeleton } from './skeleton';
import { Card, CardContent } from './card';
import { Spinner } from './Spinner';

interface LoadingScreenProps {
  type?: 'auth' | 'module';
  message?: string;
  loadingState?: 'loading' | 'ready';
  className?: string;
}

const LoadingScreen: React.FC<LoadingScreenProps> = ({
  type: _type = 'module',
  message = 'Loading...',
  loadingState: _loadingState = 'loading',
  className = ''
}) => {
  return (
    <div className={`flex items-center justify-center min-h-[400px] ${className}`}>
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center justify-center py-12 px-6 text-center">
          <div className="w-16 h-16 rounded-full bg-gray-800/50 flex items-center justify-center mb-4">
            <Spinner size="lg" className="text-primary" />
          </div>
          <Skeleton className="h-6 w-32 mb-2" />
          <Skeleton className="h-4 w-48" />
          {message && <p className="text-sm text-muted-foreground mt-2">{message}</p>}
        </CardContent>
      </Card>
    </div>
  );
};

export default LoadingScreen; 