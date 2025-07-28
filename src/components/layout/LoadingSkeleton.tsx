import React from 'react';
import { theme } from '../../config/theme';

interface LoadingSkeletonProps {
  type?: 'text' | 'button' | 'card' | 'list-item';
  width?: string;
  height?: string;
  lines?: number;
  className?: string;
}

const LoadingSkeleton: React.FC<LoadingSkeletonProps> = React.memo(({
  type = 'text',
  width = '100%',
  height = '1rem',
  lines = 1,
  className = ''
}) => {
  const baseClass = `animate-pulse ${theme.colors.progress.normal} rounded-sm`;
  
  if (type === 'text') {
    return (
      <div className={`space-y-2 ${className}`} role="status" aria-label="Loading content">
        {Array.from({ length: lines }).map((_, index) => (
          <div
            key={index}
            className={`${baseClass} h-4`}
            style={{
              width: index === lines - 1 ? '75%' : width,
            }}
          />
        ))}
        <span className="sr-only">Loading...</span>
      </div>
    );
  }

  if (type === 'button') {
    return (
      <div
        className={`${baseClass} h-10 w-32 ${className}`}
        style={{ width, height }}
        role="status"
        aria-label="Loading button"
      >
        <span className="sr-only">Loading...</span>
      </div>
    );
  }

  if (type === 'card') {
    return (
      <div className={`border ${theme.colors.border.primary} p-6 ${theme.colors.background.card} rounded-lg ${className}`} role="status" aria-label="Loading card">
        <div className="space-y-4">
          <div className={`${baseClass} h-6 w-3/4`} />
          <div className={`${baseClass} h-4 w-1/2`} />
          <div className="space-y-2">
            <div className={`${baseClass} h-3 w-full`} />
            <div className={`${baseClass} h-3 w-5/6`} />
            <div className={`${baseClass} h-3 w-4/5`} />
          </div>
        </div>
        <span className="sr-only">Loading...</span>
      </div>
    );
  }

  if (type === 'list-item') {
    return (
      <li className={`relative flex flex-col md:flex-row md:items-center justify-between px-3 sm:px-4 lg:px-6 py-6 sm:py-8 border-b ${theme.colors.border.secondary} last:border-b-0 ${theme.colors.background.card} ${className}`} role="status" aria-label="Loading list item">
        {/* Drag Handle Skeleton */}
        <div className="hidden md:flex items-center justify-center w-8 h-8 mr-3 sm:mr-3">
          <div className={`${baseClass} w-4 h-4`} />
        </div>
        
        <div className="flex-1">
          {/* Name/Title Area */}
          <div className="flex items-center gap-2 sm:gap-3 mb-3 sm:mb-4">
            <div className={`${baseClass} h-5 sm:h-6 w-1/3`} />
          </div>
          
          {/* URL Area */}
          <div className="flex items-center gap-2 sm:gap-3 mb-3 sm:mb-4">
            <div className={`${baseClass} h-4 w-1/2`} />
          </div>
          
          {/* Last Checked Info */}
          <div className="flex items-center gap-2 sm:gap-3 mb-3 sm:mb-0 px-2 sm:px-4">
            <div className={`${baseClass} h-3 w-24 sm:w-32`} />
          </div>
        </div>
        
        {/* Status/Badges Area */}
        <div className="flex flex-col items-end gap-2 mt-4 sm:mt-6 md:mt-0 px-2 sm:px-4 md:px-0">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className={`${baseClass} h-5 sm:h-6 w-12 sm:w-16 rounded-sm`} />
            <div className={`${baseClass} h-5 sm:h-6 w-16 sm:w-20 rounded-sm`} />
          </div>
        </div>
        
        {/* Menu Button Skeleton */}
        <div className="absolute top-3 sm:top-4 right-3 sm:right-4">
          <div className={`${baseClass} w-8 h-8 rounded-sm`} />
        </div>
        
        <span className="sr-only">Loading...</span>
      </li>
    );
  }

  return (
    <div
      className={`${baseClass} ${className}`}
      style={{ width, height }}
      role="status"
      aria-label="Loading"
    >
      <span className="sr-only">Loading...</span>
    </div>
  );
});

LoadingSkeleton.displayName = 'LoadingSkeleton';

export default LoadingSkeleton; 