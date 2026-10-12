import React from 'react';

interface PageContainerProps {
  children: React.ReactNode;
  className?: string;
}

// Pages fade in on arrival, so the swap from the loading skeleton (or from
// the previous page) reads as a transition rather than a flash.
export const PageContainer: React.FC<PageContainerProps> = ({ children, className }) => {
  return (
    <div className={`flex flex-1 flex-col min-w-0 w-full max-w-full animate-in fade-in-0 [animation-duration:250ms] ${className || ''}`}>
      {children}
    </div>
  );
};

