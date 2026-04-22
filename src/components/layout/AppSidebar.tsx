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
  Activity,
  FileBadge,
  ClipboardList,
} from "lucide-react"
import { useAuth, useUser } from '@clerk/clerk-react';
import { useAdmin } from '@/hooks/useAdmin';
import { usePlan } from "@/hooks/usePlan"
import { getTierVisual } from "@/lib/tier-visual"
import { cn } from "@/lib/utils"

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
      {
        title: "Badge Analytics",
        url: "/admin/badges",
        icon: Activity,
        isAdmin: true,
      },
      {
        title: "Onboarding Responses",
        url: "/admin/onboarding",
        icon: ClipboardList,
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
  const { tier, isFounders, nano } = usePlan()
  const tierVisual = getTierVisual(tier, isFounders)

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
                    {tierVisual.palette && (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 text-[10px] font-semibold lowercase",
                          tierVisual.palette.shadow,
                          tierVisual.palette.text,
                        )}
                      >
                        <tierVisual.Icon
                          className={cn("h-3 w-3", tierVisual.palette.shadow, tierVisual.palette.text)}
                        />
                        {tierVisual.label}
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
        <NavMain items={data.navMain} tier={tier} isFounders={isFounders} />
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
        <NavUser user={userData} tier={tier} isFounders={isFounders} />
      </SidebarFooter>
      </Sidebar>
  )
}
