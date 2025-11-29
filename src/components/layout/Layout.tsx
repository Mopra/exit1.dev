import React from 'react';
import { AppSidebar } from './AppSidebar';
import { SystemAlert } from './SystemAlert';
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
          <div className="sticky top-0 z-20">
            <div className="h-8 flex items-center gap-1 px-1">
              <SidebarTrigger
                className="hidden ml-4 md:block size-6 cursor-pointer text-muted-foreground hover:text-foreground hover:bg-transparent focus-visible:ring-0 opacity-40 hover:opacity-100"
                aria-label="Toggle sidebar"
                title="Toggle sidebar"
              />
            </div>
          </div>
          <SystemAlert />
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