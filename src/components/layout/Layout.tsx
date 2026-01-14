import React from 'react';
import { Link } from "react-router-dom"
import { AppSidebar } from './AppSidebar';
import { SystemAlert } from './SystemAlert';
import NotificationBell from './NotificationBell';
import { Sparkles } from "lucide-react";
import { useAuth } from "@clerk/clerk-react";
import { useNanoPlan } from "@/hooks/useNanoPlan";
import { useClerkOverlayOpen } from "@/hooks/useClerkOverlayOpen"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"

const Layout = ({ children }: { children: React.ReactNode }) => {
  useClerkOverlayOpen()
  const { isSignedIn } = useAuth();
  const { nano, isLoading } = useNanoPlan();

  return (
    <SidebarProvider defaultOpen={false}>
      <div className="flex h-svh w-full max-w-full overflow-hidden">
        <AppSidebar />
        <SidebarInset className="min-w-0 flex-1 flex flex-col overflow-hidden rounded-none m-0 md:peer-data-[variant=inset]:m-0 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-0 md:peer-data-[variant=inset]:rounded-none">
          <div className="app-topbar sticky top-0 z-20 h-12 -mb-12 overflow-visible border-b border-border/40 bg-background/60 backdrop-blur-xl backdrop-saturate-150 shadow-sm supports-[backdrop-filter]:bg-background/30 dark:bg-primary/90 dark:supports-[backdrop-filter]:bg-black/10">
            <div className="relative h-12 flex items-center gap-1 px-2 sm:px-3 md:px-4 py-1 overflow-visible">
              <SidebarTrigger
                className="ml-1 sm:ml-2 md:ml-4 size-7 sm:size-6 cursor-pointer text-muted-foreground hover:text-foreground hover:bg-transparent focus-visible:ring-0 opacity-40 hover:opacity-100 flex-shrink-0 touch-manipulation"
                aria-label="Toggle sidebar"
                title="Toggle sidebar"
              />

              {isSignedIn && !isLoading && (
                <div
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-[calc(100%-8rem)] sm:max-w-none"
                  role="status"
                  aria-label={`${nano ? "Nano" : "Free"} plan active`}
                >
                  <span className="select-none inline-flex items-center gap-1.5 sm:gap-1.5 text-xs sm:text-xs font-medium text-muted-foreground flex-wrap justify-center">
                    {nano && (
                      <Sparkles className="h-3.5 w-3.5 sm:h-3.5 sm:w-3.5 drop-shadow-[0_0_8px_rgba(252,211,77,0.55)] text-amber-300/95 flex-shrink-0" />
                    )}
                    <span
                      className={
                        nano
                          ? "font-semibold drop-shadow-[0_0_8px_rgba(252,211,77,0.45)] text-amber-300/95 whitespace-nowrap"
                          : "font-semibold text-muted-foreground/90 whitespace-nowrap"
                      }
                    >
                      {nano ? "nano" : "free"}
                    </span>
                    <span className="text-muted-foreground/80 hidden sm:inline whitespace-nowrap">plan active</span>
                    {!nano && (
                      <span className="inline-flex items-center gap-1 sm:gap-1">
                        <Button
                          asChild
                          size="sm"
                          variant="outline"
                          className="h-6 sm:h-6 px-2 sm:px-2 text-xs sm:text-xs font-medium cursor-pointer bg-transparent border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent/40 touch-manipulation whitespace-nowrap"
                        >
                          <Link to="/billing">
                            <span className="hidden sm:inline">Upgrade to Nano</span>
                            <span className="sm:hidden">Upgrade</span>
                          </Link>
                        </Button>
                      </span>
                    )}
                  </span>
                </div>
              )}

              <div className="flex-1" />
              <div className="mr-1 sm:mr-2 md:mr-4 overflow-visible pt-1 flex items-center gap-1 sm:gap-2 flex-shrink-0">
                <NotificationBell />
              </div>
            </div>
          </div>
          <SystemAlert />
          <main className="flex flex-1 flex-col min-h-0 min-w-0 overflow-y-auto overflow-x-hidden" style={{ WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', scrollbarGutter: 'stable' }}>
            <div className="flex flex-1 flex-col min-h-0 pt-16 pb-6 px-4 sm:px-6 lg:px-12">
              {children}
            </div>
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
};

export default Layout; 