import SideNav from './SideNav';
import React, { useState, useEffect } from 'react';
import { useMobile } from '../../hooks/useMobile';

const Layout = ({ children }: { children: React.ReactNode }) => {
  const isMobile = useMobile();
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Auto-collapse on mobile by default
  useEffect(() => {
    if (isMobile) {
      setIsCollapsed(true);
    } else {
      setIsCollapsed(false);
    }
  }, [isMobile]);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      <SideNav isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} />
      <div className={`transition-all duration-300 ${
        isCollapsed ? 'ml-16' : 'ml-64'
      }`}>
        <main className="p-6">
          {children}
        </main>
      </div>
    </div>
  );
};

export default Layout; 