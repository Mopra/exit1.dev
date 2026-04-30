import React from 'react';
import { Link } from "react-router-dom"
import { AppSidebar } from './AppSidebar';
import { SystemAlert } from './SystemAlert';
import { DeployModeBanner } from './DeployModeBanner';
import NotificationBell from './NotificationBell';
import FeedbackButton from './FeedbackButton';
import { GlobalSearch } from './GlobalSearch';
import { UsageWidget } from './UsageWidget';
import Footer from './Footer';
import { useAuth } from "@clerk/clerk-react";
import { usePlan } from "@/hooks/usePlan";
import { useAdmin } from "@/hooks/useAdmin";
import { useChecks } from "@/hooks/useChecks";
import { useTierSync } from "@/hooks/useTierSync"
import { getTierVisual } from "@/lib/tier-visual"
import { cn } from "@/lib/utils"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/Button"

const Layout = ({ children }: { children: React.ReactNode }) => {
  useTierSync()
  const { isSignedIn, userId } = useAuth();
  const { tier, isFounders, nano, isLoading } = usePlan();
  const { isAdmin } = useAdmin();
  const { checks } = useChecks(userId ?? null, () => {}, { realtime: true });
  const tierVisual = getTierVisual(tier, isFounders);

  return (
    <SidebarProvider defaultOpen={false}>
      <div className="flex h-svh w-full max-w-full overflow-hidden">
        <AppSidebar />
        <SidebarInset className="min-w-0 flex-1 flex flex-col overflow-clip rounded-none m-0 md:peer-data-[variant=inset]:m-0 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-0 md:peer-data-[variant=inset]:rounded-none">
          <DeployModeBanner />
          <div className="app-topbar sticky top-0 z-20 isolate h-12 -mb-12 overflow-visible border-b border-border/40 bg-background/90 backdrop-blur-xl backdrop-saturate-150 shadow-sm supports-[backdrop-filter]:bg-background/75 dark:bg-primary/95 dark:supports-[backdrop-filter]:bg-black/60">
            <div className="relative h-12 flex items-center gap-2 px-2 sm:px-3 md:px-4 py-1 overflow-visible">
              {/* Left group: sidebar trigger + plan badge */}
              <div className="flex items-center gap-1 sm:gap-2 shrink-0">
                <SidebarTrigger
                  className="hidden sm:inline-flex size-6 cursor-pointer text-muted-foreground hover:text-foreground hover:bg-transparent focus-visible:ring-0 opacity-40 hover:opacity-100 flex-shrink-0 touch-manipulation"
                  aria-label="Toggle sidebar"
                  title="Toggle sidebar"
                />
                {isSignedIn && !isLoading && (
                  <span className="select-none inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap">
                    {tierVisual.palette ? (
                      <span
                        data-tier-accent
                        className={cn(
                          "inline-flex items-center gap-1",
                          tierVisual.palette.shadow,
                        )}
                        style={{ ['--tier-accent' as string]: tierVisual.palette.glow }}
                      >
                        <tierVisual.Icon className="h-3.5 w-3.5 flex-shrink-0" />
                        <span className="font-semibold lowercase">
                          {tierVisual.label}
                        </span>
                      </span>
                    ) : (
                      <>
                        <span className="font-semibold text-muted-foreground/90">free</span>
                        <Button
                          asChild
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs font-medium cursor-pointer bg-transparent border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent/40 touch-manipulation whitespace-nowrap hidden sm:inline-flex"
                        >
                          <Link to="/billing">Upgrade</Link>
                        </Button>
                      </>
                    )}
                  </span>
                )}
              </div>

              {/* Center: global search */}
              <div className="flex-1 flex justify-center min-w-0 px-2">
                {isSignedIn && (
                  <GlobalSearch checks={checks} isAdmin={isAdmin} isPaid={nano} />
                )}
              </div>

              {/* Right: feedback + notification bell */}
              <div className="shrink-0 overflow-visible pt-1 flex items-center gap-1 sm:gap-2">
                {isSignedIn && (
                  <div className="hidden sm:flex">
                    <FeedbackButton />
                  </div>
                )}
                <NotificationBell />
              </div>
            </div>
          </div>
          <main className="flex flex-1 flex-col min-h-0 min-w-0 overflow-y-auto overflow-x-hidden" style={{ overscrollBehavior: 'contain' }}>
            <div className="flex flex-1 flex-col pt-16 pb-6 px-1 sm:px-4 md:px-6 lg:px-12">
              <SystemAlert />
              {children}
            </div>
            <Footer />
          </main>
          {isSignedIn && <UsageWidget />}
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
};

export default Layout; 
