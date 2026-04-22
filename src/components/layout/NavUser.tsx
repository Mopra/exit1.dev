import {
  BadgeCheck,
  ChevronsUpDown,
  LogOut,
  Crown,
  CreditCard,
  Eye,
} from "lucide-react"
import { useClerk } from '@clerk/clerk-react';
import { Link } from 'react-router-dom';
import { useAdmin } from '@/hooks/useAdmin';
import { useAdminTierPreview } from '@/hooks/useAdminTierPreview';
import { getInitials } from '@/lib/initials';
import { getTierVisual, type TierVisualTier } from '@/lib/tier-visual';
import { cn } from '@/lib/utils';

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

// Extracted outside NavUser to avoid re-creating the component type each render,
// which would cause React to unmount/remount the avatar on every parent update.
function UserAvatarWithBadges({
  avatarSrc,
  name,
  ringClass,
  isAdmin,
  tier,
  isFounders,
  className,
}: {
  avatarSrc: string
  name: string
  ringClass: string
  isAdmin: boolean
  tier: TierVisualTier
  isFounders: boolean
  className?: string
}) {
  const visual = getTierVisual(tier, isFounders)
  return (
    <div className={className}>
      <Avatar className={`h-8 w-8 rounded-lg ${ringClass}`}>
        <AvatarImage src={avatarSrc} alt={name} />
        <AvatarFallback className="rounded-lg">{getInitials(name)}</AvatarFallback>
      </Avatar>

      {visual.palette && (
        <div
          className={cn(
            "absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-0 flex items-center justify-center shadow-sm",
            visual.palette.dotBg,
            isAdmin && "-left-1 right-auto",
          )}
          aria-label={`${visual.label} plan active`}
          title={`${visual.label} plan active`}
        >
          <visual.Icon className="h-2.5 w-2.5" />
        </div>
      )}

      {isAdmin && (
        <div
          className="absolute -bottom-1 -right-1 w-4 h-4 bg-blue-500 rounded-full flex items-center justify-center shadow-sm"
          aria-label="Administrator"
          title="Administrator"
        >
          <Crown className="w-2.5 h-2.5 text-white" />
        </div>
      )}
    </div>
  )
}

// Per-tier avatar ring styling (ring color + soft glow). Admin ring takes
// precedence and is applied separately above.
const TIER_RING: Record<TierVisualTier, string> = {
  free: "",
  nano: "ring-2 ring-violet-300/70 shadow-lg shadow-violet-300/10",
  pro: "ring-2 ring-amber-300/70 shadow-lg shadow-amber-300/10",
  agency: "ring-2 ring-emerald-300/70 shadow-lg shadow-emerald-300/10",
}
const FOUNDERS_RING = "ring-2 ring-yellow-200/70 shadow-lg shadow-yellow-200/10"

export function NavUser({
  user,
  tier = "free",
  isFounders = false,
}: {
  user: {
    name: string
    email: string
    avatar: string
  }
  tier?: TierVisualTier
  isFounders?: boolean
}) {
  const { isMobile, state } = useSidebar()
  const { signOut } = useClerk();
  const { isAdmin } = useAdmin();
  const { previewTier, previewIsFounders, cycleTier, toggleFounders } =
    useAdminTierPreview();

  const visual = getTierVisual(tier, isFounders)
  const previewVisual = getTierVisual(previewTier, previewIsFounders)

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error('Error signing out:', error);
    }
  };

  const tierRing = isFounders && tier === "pro" ? FOUNDERS_RING : TIER_RING[tier]
  const ringClass = isAdmin
    ? "ring-2 ring-blue-400 ring-opacity-50 shadow-lg shadow-blue-400/20"
    : tierRing

  const avatarProps = {
    avatarSrc: user.avatar,
    name: user.name,
    ringClass,
    isAdmin,
    tier,
    isFounders,
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={user.name}
              className="cursor-pointer data-[state=open]:bg-sidebar-accent/60 data-[state=open]:text-sidebar-accent-foreground"
            >
              <UserAvatarWithBadges {...avatarProps} className="relative" />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium flex items-center gap-1">
                  {user.name}
                  {visual.palette && (
                    <visual.Icon className={cn("w-3 h-3", visual.palette.text)} />
                  )}
                  {isAdmin && <Crown className="w-3 h-3 text-blue-500" />}
                </span>
                <span className="truncate text-xs">{user.email}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-xl border-border/40 bg-background/80 shadow-lg backdrop-blur-xl backdrop-saturate-150 supports-[backdrop-filter]:bg-background/60"
            side={isMobile ? "bottom" : state === "collapsed" ? "right" : "top"}
            align={isMobile ? "end" : state === "collapsed" ? "end" : "start"}
            sideOffset={8}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm">
                <UserAvatarWithBadges {...avatarProps} className="relative" />
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium flex items-center gap-1">
                    {user.name}
                    {visual.palette && (
                      <visual.Icon className={cn("w-3 h-3", visual.palette.text)} />
                    )}
                    {isAdmin && <Crown className="w-3 h-3 text-blue-500" />}
                  </span>
                  <span className="truncate text-xs">{user.email}</span>
                  {visual.palette && (
                    <span className={cn("truncate text-xs font-medium", visual.palette.text)}>
                      {visual.label} plan
                    </span>
                  )}
                  {isAdmin && (
                    <span className="truncate text-xs text-blue-500 font-medium">Administrator</span>
                  )}
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link to="/profile" className="cursor-pointer">
                  <BadgeCheck />
                  Account
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/billing" className="cursor-pointer">
                  <CreditCard />
                  Billing
                </Link>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {isAdmin && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem className="cursor-pointer" onClick={cycleTier}>
                    <Eye className="w-4 h-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Preview as</span>
                    <span className="ml-auto flex items-center gap-1">
                      {previewVisual.palette ? (
                        <>
                          <previewVisual.Icon className={cn("w-3 h-3", previewVisual.palette.text)} />
                          <span className={cn("text-xs font-medium", previewVisual.palette.text)}>
                            {previewVisual.label}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground text-xs font-medium">Free</span>
                      )}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.preventDefault();
                      toggleFounders();
                    }}
                  >
                    <Eye className="w-4 h-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Founders preview</span>
                    <span className="ml-auto text-xs font-medium">
                      {previewIsFounders ? (
                        <span className="text-yellow-200">On</span>
                      ) : (
                        <span className="text-muted-foreground">Off</span>
                      )}
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              className="cursor-pointer"
              onClick={handleSignOut}
            >
              <LogOut />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
