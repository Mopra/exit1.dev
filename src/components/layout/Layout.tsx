import React from 'react';
import { AppSidebar } from './AppSidebar';
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { useMobile } from '@/hooks/useMobile';

const Layout = ({ children }: { children: React.ReactNode }) => {
  const isMobile = useMobile();
  
  return (
    <SidebarProvider defaultOpen={!isMobile}>
      <div className="flex h-screen w-screen overflow-hidden">
        <AppSidebar />
        <SidebarInset className="min-w-0 flex-1 overflow-hidden ml-12 md:ml-40 lg:ml-20 peer-data-[state=expanded]:ml-64 md:peer-data-[state=expanded]:ml-68 lg:peer-data-[state=expanded]:ml-72" style={{marginLeft: 'clamp(48px, 10vw, 0px)'}}>
          <main className="flex flex-1 flex-col h-full min-w-0 overflow-y-auto overflow-x-hidden">
            <div className="py-6 px-6 sm:px-12">
              {children}
            </div>
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
};

export default Layout; 