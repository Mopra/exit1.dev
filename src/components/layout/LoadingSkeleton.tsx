import React from 'react';
import { Skeleton } from '../ui/skeleton';

interface LoadingSkeletonProps {
  type?: 'list-item' | 'card' | 'table-row';
  count?: number;
  className?: string;
}

const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({
  type = 'list-item',
  count = 1,
  className = ''
}) => {
  const renderSkeleton = () => {
    switch (type) {
      case 'card':
        return <Skeleton className="h-32 w-full rounded-lg" />;
      case 'table-row':
        return (
          <div className="flex items-center space-x-4">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-20" />
          </div>
        );
      default:
        return <Skeleton className="h-16 w-full rounded-lg" />;
    }
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index}>
          {renderSkeleton()}
        </div>
      ))}
    </div>
  );
};

export default LoadingSkeleton; 