import React from 'react';
import { AppSidebar } from './AppSidebar';
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"

const Layout = ({ children }: { children: React.ReactNode }) => {
  return (
    <SidebarProvider>
      <div className="flex h-screen w-screen overflow-hidden">
        <AppSidebar />
        <SidebarInset className="min-w-0 flex-1 overflow-hidden">
          <main className="flex flex-1 flex-col h-full min-w-0 overflow-y-auto overflow-x-hidden">
            <div className="p-6">
              {children}
            </div>
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
};

export default Layout; 