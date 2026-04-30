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
  ],
  navAdmin: isAdmin ? [
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
  ] : [],
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
              <a href="/" className="cursor-pointer hover:!bg-transparent rounded-none group-data-[collapsible=icon]:!px-1">
                <img src="/e_.svg" alt="Exit1.dev Logo" className="size-6 shrink-0 rounded-none" />
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">
                    exit1.dev
                  </span>
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} tier={tier} isFounders={isFounders} />
        {isAdmin && data.navAdmin.length > 0 && (
          <NavMain
            items={data.navAdmin}
            tier={tier}
            isFounders={isFounders}
            className="mt-4 border-t border-sidebar-border pt-4"
          />
        )}
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
