import { Link, useLocation } from 'react-router-dom';
import { type LucideIcon } from "lucide-react"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { isAnimatedIcon, useIconMotion, type AnimatedIcon } from "@/components/ui/animated-icons"
import { getTierVisual, type TierVisualTier } from "@/lib/tier-visual"
import { cn } from "@/lib/utils"

type NavMainItem = {
  title: string
  url: string
  icon?: LucideIcon | AnimatedIcon
  isAdmin?: boolean
  activePaths?: string[]
}

export function NavMain({
  items,
  tier = "free",
  isFounders = false,
  className,
}: {
  items: NavMainItem[]
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
            <NavMainRow
              key={item.title}
              item={item}
              isActive={isActivePath(item)}
              iconClassName={cn(
                item.isAdmin
                  ? "drop-shadow-[0_0_6px_var(--primary)] text-primary"
                  : tierVisual.palette
                    ? cn(tierVisual.palette.shadow, tierVisual.palette.text)
                    : "",
              )}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

// Its own component so each row holds its own hover state: hovering anywhere
// on the row plays the icon's animation, not just over the 16px glyph.
function NavMainRow({
  item,
  isActive,
  iconClassName,
}: {
  item: NavMainItem
  isActive: boolean
  iconClassName: string
}) {
  const [motion, motionHandlers] = useIconMotion()
  const Icon = item.icon

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={item.title} isActive={isActive}>
        <Link to={item.url} className="cursor-pointer" {...motionHandlers}>
          {Icon && (isAnimatedIcon(Icon)
            ? <Icon className={iconClassName} motion={motion} />
            : <Icon className={iconClassName} />)}
          <span>{item.title}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
