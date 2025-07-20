import React from 'react';

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const Spinner: React.FC<SpinnerProps> = React.memo(({
  size = 'md',
  className = ''
}) => {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-6 h-6',
    lg: 'w-8 h-8'
  };

  return (
    <div
      className={`animate-spin rounded-full border-2 border-white/30 border-t-white ${sizeClasses[size]} ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
});

Spinner.displayName = 'Spinner';

export default Spinner; 