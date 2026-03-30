import * as React from "react"
import {
  Globe,
  Database,
  HelpCircle,
  BookOpen,
  BarChart3,
  Webhook,
  Mail,
  MessageSquare,
  Code,
  Shield,
  Users,
  Bell,
  Sparkles,
  Zap,
  Activity,
  FileBadge,
} from "lucide-react"
import { useAuth, useUser } from '@clerk/clerk-react';
import { useAdmin } from '@/hooks/useAdmin';
import { useNanoPlan } from "@/hooks/useNanoPlan"

import { NavMain } from "./NavMain"
import { NavSecondary } from "./NavSecondary"
import { NavUser } from "./NavUser"
import { DeployModeToggle } from "@/components/admin/DeployModeToggle"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
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
      title: "Status",
      url: "/status",
      icon: Activity,
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
      title: "Domain Intel",
      url: "/domain-intelligence",
      icon: FileBadge,
    },
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
      title: "Docs",
      url: "https://docs.exit1.dev",
      icon: BookOpen,
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
  const { nano, scale } = useNanoPlan()

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
                    {scale && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold drop-shadow-[0_0_8px_rgba(56,189,248,0.45)] text-sky-300/95">
                        <Zap className="h-3 w-3 drop-shadow-[0_0_8px_rgba(56,189,248,0.55)] text-sky-300/95" />
                        scale
                      </span>
                    )}
                    {!scale && nano && (
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
        {isAdmin && (
          <SidebarGroup>
            <SidebarGroupContent>
              <DeployModeToggle />
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={userData} nano={nano} scale={scale} />
      </SidebarFooter>
      </Sidebar>
  )
}
