import * as React from "react"
import { LazyMotion } from "motion/react"
import {
  Shield,
  Users,
  Bell,
  Activity,
  ClipboardList,
  UsersRound,
  ChevronsUpDown,
  Check,
} from "lucide-react"
import {
  ActivityIcon,
  BookOpenIcon,
  BotIcon,
  ChartColumnIcon,
  CodeIcon,
  CreditCardIcon,
  DatabaseIcon,
  FileBadgeIcon,
  GlobeIcon,
  MailIcon,
  MessageSquareIcon,
  PlugIcon,
  RadioIcon,
  UsersRoundIcon,
  WebhookIcon,
} from "@/components/ui/animated-icons"

const loadMotionFeatures = () =>
  import("@/components/ui/motion-features").then((mod) => mod.default)

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 365.467"
      className={className}
      fill="currentColor"
      shapeRendering="geometricPrecision"
      textRendering="geometricPrecision"
      imageRendering="optimizeQuality"
      fillRule="evenodd"
      clipRule="evenodd"
      aria-hidden="true"
    >
      <path d="M378.186 365.028s-15.794-18.865-28.956-35.099c57.473-16.232 79.41-51.77 79.41-51.77-17.989 11.846-35.099 20.182-50.454 25.885-21.938 9.213-42.997 14.917-63.617 18.866-42.118 7.898-80.726 5.703-113.631-.438-25.008-4.827-46.506-11.407-64.494-18.867-10.091-3.947-21.059-8.774-32.027-14.917-1.316-.877-2.633-1.316-3.948-2.193-.877-.438-1.316-.878-1.755-.878-7.898-4.388-12.285-7.458-12.285-7.458s21.06 34.659 76.779 51.331c-13.163 16.673-29.395 35.977-29.395 35.977C36.854 362.395 0 299.218 0 299.218 0 159.263 63.177 45.633 63.177 45.633 126.354-1.311 186.022.005 186.022.005l4.388 5.264C111.439 27.645 75.461 62.305 75.461 62.305s9.653-5.265 25.886-12.285c46.945-20.621 84.236-25.885 99.592-27.64 2.633-.439 4.827-.878 7.458-.878 26.763-3.51 57.036-4.387 88.624-.878 41.68 4.826 86.43 17.111 132.058 41.68 0 0-34.66-32.906-109.244-55.281l6.143-7.019s60.105-1.317 122.844 45.628c0 0 63.178 113.631 63.178 253.585 0-.438-36.854 62.739-133.813 65.81l-.001.001zm-43.874-203.133c-25.006 0-44.75 21.498-44.75 48.262 0 26.763 20.182 48.26 44.75 48.26 25.008 0 44.752-21.497 44.752-48.26 0-26.764-20.182-48.262-44.752-48.262zm-160.135 0c-25.008 0-44.751 21.498-44.751 48.262 0 26.763 20.182 48.26 44.751 48.26 25.007 0 44.75-21.497 44.75-48.26.439-26.763-19.742-48.262-44.75-48.262z" />
    </svg>
  );
}
import { useAuth, useUser } from '@clerk/clerk-react';
import { useAdmin } from '@/hooks/useAdmin';
import { usePlan } from "@/hooks/usePlan"
import { teamAccountLabel, useAccount } from "@/AccountProvider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

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

const getNavData = (isAdmin: boolean, smsAlerts: boolean) => ({
  navMain: [
    {
      title: "Checks",
      url: "/checks",
      icon: GlobeIcon,
    },
    {
      title: "Live",
      url: "/check",
      icon: RadioIcon,
      activePaths: ["/checks/"],
    },
    {
      title: "Reports",
      url: "/reports",
      icon: ChartColumnIcon,
    },
    {
      title: "Status",
      url: "/status",
      icon: ActivityIcon,
    },
    {
      title: "Webhooks",
      url: "/webhooks",
      icon: WebhookIcon,
    },
    {
      title: "Integrations",
      url: "/integrations",
      icon: PlugIcon,
    },
    {
      title: "Emails",
      url: "/emails",
      icon: MailIcon,
    },
    // SMS is Pro-only (TIER_LIMITS.smsAlerts). This used to key off the `nano`
    // boolean, which showed Nano users a nav item they could not use.
    ...(smsAlerts || isAdmin ? [
      {
        title: "SMS",
        url: "/sms",
        icon: MessageSquareIcon,
      },
    ] : []),
    {
      title: "Domain Intel",
      url: "/domain-intelligence",
      icon: FileBadgeIcon,
    },
    {
      title: "Logs",
      url: "/logs",
      icon: DatabaseIcon,
    },
    {
      title: "API",
      url: "/api-keys",
      icon: CodeIcon,
    },
    {
      title: "MCP",
      url: "/mcp",
      icon: BotIcon,
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
      title: "Team",
      url: "/team",
      icon: UsersRoundIcon,
    },
    // Billing used to be reachable only from the avatar menu, and people kept
    // asking how to upgrade or change their card. It sits here, always visible.
    {
      title: "Plans & billing",
      url: "/billing",
      icon: CreditCardIcon,
    },
    {
      title: "Docs",
      url: "https://docs.exit1.dev",
      icon: BookOpenIcon,
    },
    {
      title: "Discord community",
      url: "https://discord.com/invite/uZvWbpwJZS",
      icon: DiscordIcon,
    },
  ],
})

/**
 * Switch between your own account and the teams you belong to. Hidden for the
 * many people who are in no team, so the sidebar doesn't grow a control they
 * can't use.
 */
function AccountSwitcher() {
  const account = useAccount()
  const activeTeams = account.teams.filter((t) => t.active)
  if (activeTeams.length === 0) return null

  const currentLabel = account.activeTeam ? teamAccountLabel(account.activeTeam) : "My account"

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="sm"
            className="cursor-pointer border border-sidebar-border data-[state=open]:bg-sidebar-accent"
            tooltip={`Account: ${currentLabel}`}
          >
            <UsersRound className="size-4 shrink-0" />
            <span className="truncate">{currentLabel}</span>
            <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-60" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Switch account</DropdownMenuLabel>
          <DropdownMenuItem className="cursor-pointer" onSelect={() => account.switchAccount(null)}>
            <span className="truncate">My account</span>
            {!account.isMember && <Check className="ml-auto size-4" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {activeTeams.map((team) => (
            <DropdownMenuItem
              key={team.accountId}
              className="cursor-pointer"
              onSelect={() => account.switchAccount(team.accountId)}
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate">{teamAccountLabel(team)}</span>
                <span className="text-xs text-muted-foreground">{team.role === "editor" ? "Editor" : "Viewer"}</span>
              </div>
              {account.accountId === team.accountId && <Check className="ml-auto size-4" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { isSignedIn } = useAuth();
  const { user } = useUser();
  const { isAdmin } = useAdmin();
  const { tier, isFounders, smsAlerts } = usePlan()

  const userData = {
    name: user?.fullName || user?.firstName || "User",
    email: user?.primaryEmailAddress?.emailAddress || "user@example.com",
    avatar: user?.imageUrl || "/avatars/default.jpg",
  };

  if (!isSignedIn) {
    return null;
  }

  const data = getNavData(isAdmin, smsAlerts);

  return (
    <LazyMotion features={loadMotionFeatures}>
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
            <AccountSwitcher />
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
    </LazyMotion>
  )
}
