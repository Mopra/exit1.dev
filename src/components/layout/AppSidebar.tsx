import * as React from "react"
import { LazyMotion } from "motion/react"
import { ChevronsUpDown, Check } from "lucide-react"
import {
  ActivityIcon,
  BellIcon,
  BookOpenIcon,
  BotIcon,
  ChartColumnIcon,
  ClipboardListIcon,
  CodeIcon,
  CreditCardIcon,
  DatabaseIcon,
  DiscordIcon,
  FileBadgeIcon,
  GlobeIcon,
  MailIcon,
  MessageSquareIcon,
  PlugIcon,
  RadioIcon,
  ShieldIcon,
  UsersIcon,
  UsersRoundIcon,
  WebhookIcon,
  useIconMotion,
} from "@/components/ui/animated-icons"

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
import { Logo } from "@/components/ui/Logo"

// motion's animation features load after first paint, so the sidebar icons'
// hover animations stay out of the bundle every page waits on.
const loadMotionFeatures = () =>
  import("@/components/ui/motion-features").then((mod) => mod.default)

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
      icon: ShieldIcon,
      isAdmin: true,
    },
    {
      title: "System Notifications",
      url: "/admin/notifications",
      icon: BellIcon,
      isAdmin: true,
    },
    {
      title: "User Admin",
      url: "/user-admin",
      icon: UsersIcon,
      isAdmin: true,
    },
    {
      title: "Badge Analytics",
      url: "/admin/badges",
      icon: ActivityIcon,
      isAdmin: true,
    },
    {
      title: "Onboarding Responses",
      url: "/admin/onboarding",
      icon: ClipboardListIcon,
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
  const [iconMotion, iconMotionHandlers] = useIconMotion()

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="sm"
            className="cursor-pointer border border-sidebar-border data-[state=open]:bg-sidebar-accent"
            tooltip={`Account: ${currentLabel}`}
            {...iconMotionHandlers}
          >
            <UsersRoundIcon className="size-4 shrink-0" motion={iconMotion} />
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
                  <Logo className="size-6!" />
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
