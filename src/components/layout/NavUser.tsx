import {
  BadgeCheck,
  ChevronsUpDown,
  LogOut,
  Crown,
  CreditCard,
  Sparkles,
  Zap,
  Eye,
} from "lucide-react"
import { useClerk } from '@clerk/clerk-react';
import { Link } from 'react-router-dom';
import { useAdmin } from '@/hooks/useAdmin';
import { useAdminTierPreview } from '@/hooks/useAdminTierPreview';

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import { Badge } from "@/components/ui/Badge"
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

export function NavUser({
  user,
  nano = false,
  scale = false,
}: {
  user: {
    name: string
    email: string
    avatar: string
  }
  nano?: boolean
  scale?: boolean
}) {
  const { isMobile, state } = useSidebar()
  const { signOut } = useClerk();
  const { isAdmin } = useAdmin();
  const { previewTier, cycleTier } = useAdminTierPreview();

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error('Error signing out:', error);
    }
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(word => word.charAt(0).toUpperCase())
      .join('')
      .slice(0, 2);
  };

  const ringClass = isAdmin
    ? "ring-2 ring-blue-400 ring-opacity-50 shadow-lg shadow-blue-400/20"
    : scale
      ? "ring-2 ring-sky-300/70 shadow-lg shadow-sky-300/10"
      : nano
        ? "ring-2 ring-amber-300/70 shadow-lg shadow-amber-300/10"
        : ""

  const UserAvatarWithBadges = ({ className }: { className?: string }) => {
    return (
      <div className={className}>
        <Avatar className={`h-8 w-8 rounded-lg ${ringClass}`}>
          <AvatarImage src={user.avatar} alt={user.name} />
          <AvatarFallback className="rounded-lg">{getInitials(user.name)}</AvatarFallback>
        </Avatar>

        {scale && (
          <Badge
            variant="secondary"
            className={[
              "absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-0 px-0 py-0",
              "flex items-center justify-center shadow-sm",
              "bg-sky-400 text-black",
              isAdmin ? "-left-1 right-auto" : "",
            ].join(" ")}
            aria-label="Scale plan active"
            title="Scale plan active"
          >
            <Zap className="h-2.5 w-2.5" />
          </Badge>
        )}

        {!scale && nano && (
          <Badge
            variant="secondary"
            className={[
              "absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-0 px-0 py-0",
              "flex items-center justify-center shadow-sm",
              "bg-amber-400 text-black",
              isAdmin ? "-left-1 right-auto" : "",
            ].join(" ")}
            aria-label="Nano plan active"
            title="Nano plan active"
          >
            <Sparkles className="h-2.5 w-2.5" />
          </Badge>
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
              <UserAvatarWithBadges className="relative" />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium flex items-center gap-1">
                  {user.name}
                  {scale && <Zap className="w-3 h-3 text-sky-300/90" />}
                  {!scale && nano && <Sparkles className="w-3 h-3 text-amber-300/90" />}
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
                <UserAvatarWithBadges className="relative" />
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium flex items-center gap-1">
                    {user.name}
                    {scale && <Zap className="w-3 h-3 text-sky-300/90" />}
                    {!scale && nano && <Sparkles className="w-3 h-3 text-amber-300/90" />}
                    {isAdmin && <Crown className="w-3 h-3 text-blue-500" />}
                  </span>
                  <span className="truncate text-xs">{user.email}</span>
                  {scale && (
                    <span className="truncate text-xs text-sky-300/90 font-medium">
                      Scale plan
                    </span>
                  )}
                  {!scale && nano && (
                    <span className="truncate text-xs text-amber-300/90 font-medium">
                      Nano plan
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
                      {previewTier === "scale" && (
                        <>
                          <Zap className="w-3 h-3 text-sky-300" />
                          <span className="text-sky-300 text-xs font-medium">Scale</span>
                        </>
                      )}
                      {previewTier === "nano" && (
                        <>
                          <Sparkles className="w-3 h-3 text-amber-300" />
                          <span className="text-amber-300 text-xs font-medium">Nano</span>
                        </>
                      )}
                      {previewTier === "free" && (
                        <span className="text-muted-foreground text-xs font-medium">Free</span>
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