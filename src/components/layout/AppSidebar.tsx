import * as React from "react"
import {
  Globe,
  Database,
  HelpCircle,
  BarChart3,
  Webhook,
  Mail,
  Code,
  Shield,
  Award,
  Users,
  Send,
  Bell,
  Sparkles,
} from "lucide-react"
import { useAuth, useUser } from '@clerk/clerk-react';
import { useAdmin } from '@/hooks/useAdmin';
import { useSubscription } from "@clerk/clerk-react/experimental"
import { isNanoPlan } from "@/lib/subscription"

import { NavMain } from "./NavMain"
import { NavSecondary } from "./NavSecondary"
import { NavUser } from "./NavUser"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

const getNavData = (isAdmin: boolean) => ({
  navMain: [
    {
      title: "Checks",
      url: "/checks",
      icon: Globe,
    },
    {
      title: "Reports",
      url: "/reports",
      icon: BarChart3,
    },
    {
      title: "Webhooks",
      url: "/webhooks",
      icon: Webhook,
    },
    {
      title: "Emails",
      url: "/emails",
      icon: Mail,
    },
    {
      title: "Logs",
      url: "/logs",
      icon: Database,
    },
    {
      title: "API",
      url: "/api",
      icon: Code,
    },
    {
      title: "Badge",
      url: "/badge",
      icon: Award,
    },
    ...(isAdmin ? [
      {
        title: "Admin Dashboard",
        url: "/admin",
        icon: Shield,
        isAdmin: true,
      },
      {
        title: "System Notifications",
        url: "/admin/notifications",
        icon: Bell,
        isAdmin: true,
      },
      {
        title: "User Admin",
        url: "/user-admin",
        icon: Users,
        isAdmin: true,
      },
      {
        title: "Admin Email",
        url: "/admin-email",
        icon: Send,
        isAdmin: true,
      },
    ] : []),
  ],
  navSecondary: [
    {
      title: "Status",
      url: "/status",
      icon: BarChart3,
    },
    {
      title: "Help",
      url: "https://discord.com/invite/uZvWbpwJZS",
      icon: HelpCircle,
    },
  ],
})

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { user } = useUser();
  const { isSignedIn } = useAuth();
  const { isAdmin } = useAdmin();
  const { data: subscription } = useSubscription({ enabled: Boolean(isSignedIn) })
  const nano = isNanoPlan(subscription ?? null)

  const userData = {
    name: user?.fullName || user?.firstName || "User",
    email: user?.primaryEmailAddress?.emailAddress || "user@example.com",
    avatar: user?.imageUrl || "/avatars/default.jpg",
  };

  if (!isSignedIn) {
    return null;
  }

  const data = getNavData(isAdmin);

  return (
    <Sidebar 
      variant="sidebar" 
      collapsible="icon"
      {...props}
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href="/" className="cursor-pointer hover:!bg-transparent rounded-none group-data-[collapsible=icon]:p-2">
                <img src="/e_.svg" alt="Exit1.dev Logo" className="size-8 shrink-0 rounded-none" />
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium flex items-center gap-2">
                    exit1.dev
                    {nano && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-sky-200/90">
                        <Sparkles className="h-3 w-3" />
                        nano
                      </span>
                    )}
                  </span>
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} nano={nano} />
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={userData} nano={nano} />
      </SidebarFooter>
      </Sidebar>
  )
}
