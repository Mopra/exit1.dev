import React from 'react';

interface PageContainerProps {
  children: React.ReactNode;
  className?: string;
}

export const PageContainer: React.FC<PageContainerProps> = ({ children, className }) => {
  return (
    <div className={`flex flex-1 flex-col min-w-0 w-full max-w-full ${className || ''}`}>
      {children}
    </div>
  );
};

