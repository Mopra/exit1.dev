import * as React from "react"
import {
  Globe,
  Database,
  HelpCircle,
  BarChart3,
  Webhook,
  Mail,
  MessageSquare,
  Code,
  Shield,
  Award,
  Users,
  Bell,
  Sparkles,
} from "lucide-react"
import { useAuth, useUser } from '@clerk/clerk-react';
import { useAdmin } from '@/hooks/useAdmin';
import { useNanoPlan } from "@/hooks/useNanoPlan"
import { FEATURES } from "@/config/features"

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

const getNavData = (isAdmin: boolean, nano: boolean) => ({
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
    ...(nano || isAdmin ? [
      {
        title: "SMS",
        url: "/sms",
        icon: MessageSquare,
      },
    ] : []),
    {
      title: "Logs",
      url: "/logs",
      icon: Database,
    },
    {
      title: "API",
      url: "/api-keys",
      icon: Code,
    },
    ...(FEATURES.embeddableBadges ? [
      {
        title: "Badge",
        url: "/badge",
        icon: Award,
      },
    ] : []),
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
  const { isSignedIn } = useAuth();
  const { user } = useUser();
  const { isAdmin } = useAdmin();
  const { nano } = useNanoPlan()

  const userData = {
    name: user?.fullName || user?.firstName || "User",
    email: user?.primaryEmailAddress?.emailAddress || "user@example.com",
    avatar: user?.imageUrl || "/avatars/default.jpg",
  };

  if (!isSignedIn) {
    return null;
  }

  const data = getNavData(isAdmin, nano);

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
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold drop-shadow-[0_0_8px_rgba(252,211,77,0.45)] text-amber-300/95">
                        <Sparkles className="h-3 w-3 drop-shadow-[0_0_8px_rgba(252,211,77,0.55)] text-amber-300/95" />
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
