import * as React from "react"
import {
  Globe,
  Bell,
  Database,
  User,
  Settings,
  HelpCircle,
  BarChart3,
  Zap,
} from "lucide-react"
import { useAuth, useUser } from '@clerk/clerk-react';

import { NavMain } from "./NavMain"
import { NavProjects } from "./NavProjects"
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

const data = {
  navMain: [
    {
      title: "Checks",
      url: "/checks",
      icon: Globe,
    },
    {
      title: "Webhooks",
      url: "/webhooks",
      icon: Bell,
    },
    {
      title: "Logs",
      url: "/logs",
      icon: Database,
    },
    {
      title: "Statistics",
      url: "/statistics",
      icon: BarChart3,
    },
    {
      title: "Incidents",
      url: "/incidents",
      icon: Zap,
    },
  ],
  navSecondary: [
    {
      title: "Profile",
      url: "/profile",
      icon: User,
    },
    {
      title: "Settings",
      url: "/settings",
      icon: Settings,
    },
    {
      title: "Help",
      url: "/help",
      icon: HelpCircle,
    },
  ],
  projects: [
    {
      name: "Successful Checks",
      url: "/successful-checks",
      icon: Globe,
    },
    {
      name: "BigQuery Logs",
      url: "/logs-bigquery",
      icon: Database,
    },
    {
      name: "Status Page",
      url: "/status",
      icon: BarChart3,
    },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { user } = useUser();
  const { isSignedIn } = useAuth();

  const userData = {
    name: user?.fullName || user?.firstName || "User",
    email: user?.primaryEmailAddress?.emailAddress || "user@example.com",
    avatar: user?.imageUrl || "/avatars/default.jpg",
  };

  if (!isSignedIn) {
    return null;
  }

  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href="/">
                <div className="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <Globe className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">Exit1.dev</span>
                  <span className="truncate text-xs">Monitoring Platform</span>
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} />
        <NavProjects projects={data.projects} />
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={userData} />
      </SidebarFooter>
    </Sidebar>
  )
}
