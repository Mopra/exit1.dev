import React from 'react';
import { AppSidebar } from './AppSidebar';
import { SystemAlert } from './SystemAlert';
import NotificationBell from './NotificationBell';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"

const Layout = ({ children }: { children: React.ReactNode }) => {
  return (
    <SidebarProvider defaultOpen={false}>
      <div className="flex h-screen w-screen overflow-hidden">
        <AppSidebar />
        <SidebarInset className="min-w-0 flex-1 overflow-hidden">
          <div className="sticky top-0 z-20 overflow-visible">
            <div className="h-12 flex items-center gap-1 px-2 sm:px-1 py-1 overflow-visible">
              <SidebarTrigger
                className="hidden ml-2 sm:ml-4 md:block size-6 cursor-pointer text-muted-foreground hover:text-foreground hover:bg-transparent focus-visible:ring-0 opacity-40 hover:opacity-100 flex-shrink-0"
                aria-label="Toggle sidebar"
                title="Toggle sidebar"
              />
              <div className="flex-1" />
              <div className="mr-2 sm:mr-4 overflow-visible pt-1 flex-shrink-0">
                <NotificationBell />
              </div>
            </div>
          </div>
          <div className="pt-12 sm:pt-8 mx-6 sm:mx-12">
            <SystemAlert />
          </div>
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