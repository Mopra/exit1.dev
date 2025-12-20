import {
  BadgeCheck,
  ChevronsUpDown,
  LogOut,
  Crown,
  CreditCard,
} from "lucide-react"
import { useClerk } from '@clerk/clerk-react';
import { Link } from 'react-router-dom';
import { useAdmin } from '@/hooks/useAdmin';

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

export function NavUser({
  user,
}: {
  user: {
    name: string
    email: string
    avatar: string
  }
}) {
  const { isMobile } = useSidebar()
  const { signOut } = useClerk();
  const { isAdmin } = useAdmin();

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

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={user.name}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="relative">
                <Avatar className={`h-8 w-8 rounded-lg ${isAdmin ? 'ring-2 ring-blue-400 ring-opacity-50 shadow-lg shadow-blue-400/20' : ''}`}>
                  <AvatarImage src={user.avatar} alt={user.name} />
                  <AvatarFallback className="rounded-lg">{getInitials(user.name)}</AvatarFallback>
                </Avatar>
                {isAdmin && (
                  <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-blue-500 rounded-full flex items-center justify-center shadow-sm">
                    <Crown className="w-2.5 h-2.5 text-white" />
                  </div>
                )}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium flex items-center gap-1">
                  {user.name}
                  {isAdmin && <Crown className="w-3 h-3 text-blue-500" />}
                </span>
                <span className="truncate text-xs">{user.email}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <div className="relative">
                  <Avatar className={`h-8 w-8 rounded-lg ${isAdmin ? 'ring-2 ring-blue-400 ring-opacity-50 shadow-lg shadow-blue-400/20' : ''}`}>
                    <AvatarImage src={user.avatar} alt={user.name} />
                    <AvatarFallback className="rounded-lg">{getInitials(user.name)}</AvatarFallback>
                  </Avatar>
                  {isAdmin && (
                    <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-blue-500 rounded-full flex items-center justify-center shadow-sm">
                      <Crown className="w-2.5 h-2.5 text-white" />
                    </div>
                  )}
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium flex items-center gap-1">
                    {user.name}
                    {isAdmin && <Crown className="w-3 h-3 text-blue-500" />}
                  </span>
                  <span className="truncate text-xs">{user.email}</span>
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
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSignOut}>
              <LogOut />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}