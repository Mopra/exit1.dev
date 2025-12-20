import React from 'react';
import { Link } from "react-router-dom"
import { AppSidebar } from './AppSidebar';
import { SystemAlert } from './SystemAlert';
import NotificationBell from './NotificationBell';
import { Sparkles } from "lucide-react";
import { useAuth } from "@clerk/clerk-react";
import { useSubscription } from "@clerk/clerk-react/experimental";
import { isNanoPlan } from "@/lib/subscription";
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
  const { data: subscription, isLoading } = useSubscription({ enabled: Boolean(isSignedIn) });
  const nano = isNanoPlan(subscription ?? null);

  return (
    <SidebarProvider defaultOpen={false}>
      <div className="flex h-screen w-screen overflow-hidden">
        <AppSidebar />
        <SidebarInset className="min-w-0 flex-1 overflow-hidden rounded-none m-0 md:peer-data-[variant=inset]:m-0 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-0 md:peer-data-[variant=inset]:rounded-none">
          <div className="app-topbar sticky top-0 z-20 h-12 -mb-12 overflow-visible border-b border-border/40 bg-background/60 backdrop-blur-xl backdrop-saturate-150 shadow-sm supports-[backdrop-filter]:bg-background/30 dark:bg-primary/90 dark:supports-[backdrop-filter]:bg-black/10">
            <div className="relative h-12 flex items-center gap-1 px-2 sm:px-1 py-1 overflow-visible">
              <SidebarTrigger
                className="hidden ml-2 sm:ml-4 md:block size-6 cursor-pointer text-muted-foreground hover:text-foreground hover:bg-transparent focus-visible:ring-0 opacity-40 hover:opacity-100 flex-shrink-0"
                aria-label="Toggle sidebar"
                title="Toggle sidebar"
              />

              {isSignedIn && !isLoading && (
                <div
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                  role="status"
                  aria-label={`${nano ? "Nano" : "Free"} plan active`}
                >
                  <span className="select-none inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    {nano && (
                      <Sparkles className="h-3.5 w-3.5 drop-shadow-[0_0_8px_rgba(252,211,77,0.55)] text-amber-300/95" />
                    )}
                    <span
                      className={
                        nano
                          ? "font-semibold drop-shadow-[0_0_8px_rgba(252,211,77,0.45)] text-amber-300/95"
                          : "font-semibold text-muted-foreground/90"
                      }
                    >
                      {nano ? "nano" : "free"}
                    </span>
                    <span className="text-muted-foreground/80">plan active</span>
                    {!nano && (
                      <span className="inline-flex items-center gap-1">
                        <span className="text-muted-foreground/50"></span>
                        <Button
                          asChild
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs font-medium cursor-pointer bg-transparent border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent/40"
                        >
                          <Link to="/billing">Upgrade to Nano</Link>
                        </Button>
                        <span className="text-muted-foreground/50"></span>
                      </span>
                    )}
                  </span>
                </div>
              )}

              <div className="flex-1" />
              <div className="mr-2 sm:mr-4 overflow-visible pt-1 flex items-center gap-2 flex-shrink-0">
                <NotificationBell />
              </div>
            </div>
          </div>
          <SystemAlert />
          <main className="flex flex-1 flex-col h-full min-w-0 overflow-y-auto overflow-x-hidden">
            <div className="pt-16 pb-6 px-6 sm:px-12">
              {children}
            </div>
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
};

export default Layout; 