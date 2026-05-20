import { Link, useLocation } from 'react-router-dom';
import { type LucideIcon } from "lucide-react"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { getTierVisual, type TierVisualTier } from "@/lib/tier-visual"
import { cn } from "@/lib/utils"

export function NavMain({
  items,
  tier = "free",
  isFounders = false,
  className,
}: {
  items: {
    title: string
    url: string
    icon?: LucideIcon
    isAdmin?: boolean
    activePaths?: string[]
  }[]
  tier?: TierVisualTier
  isFounders?: boolean
  className?: string
}) {
  const location = useLocation();
  const tierVisual = getTierVisual(tier, isFounders)

  const isActivePath = (item: { url: string; activePaths?: string[] }) => {
    if (location.pathname === item.url) return true;
    return item.activePaths?.some((p) => location.pathname.startsWith(p)) ?? false;
  };

  return (
    <SidebarGroup className={className}>
      <SidebarGroupContent className="flex flex-col gap-2">
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild
                tooltip={item.title}
                isActive={isActivePath(item)}
              >
                <Link to={item.url} className="cursor-pointer">
                  {item.icon && (
                    <item.icon
                      className={cn(
                        item.isAdmin
                          ? "drop-shadow-[0_0_6px_var(--primary)] text-primary"
                          : tierVisual.palette
                            ? cn(tierVisual.palette.shadow, tierVisual.palette.text)
                            : "",
                      )}
                    />
                  )}
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
