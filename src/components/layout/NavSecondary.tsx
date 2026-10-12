import * as React from "react"
import { Link, useLocation } from 'react-router-dom';

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { isAnimatedIcon, useIconMotion, type AnimatedIcon } from "@/components/ui/animated-icons"

type NavSecondaryItem = {
  title: string
  url: string
  icon?: React.ComponentType<{ className?: string }> | AnimatedIcon
}

export function NavSecondary({
  items,
  ...props
}: {
  items: NavSecondaryItem[]
} & React.ComponentPropsWithoutRef<typeof SidebarGroup>) {
  const location = useLocation();

  const isActivePath = (path: string) => {
    return location.pathname === path;
  };

  const isExternalLink = (url: string) => {
    return url.startsWith('http://') || url.startsWith('https://');
  };

  return (
    <SidebarGroup {...props}>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <NavSecondaryRow
              key={item.title}
              item={item}
              isActive={!isExternalLink(item.url) && isActivePath(item.url)}
              isExternal={isExternalLink(item.url)}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function NavSecondaryRow({
  item,
  isActive,
  isExternal,
}: {
  item: NavSecondaryItem
  isActive: boolean
  isExternal: boolean
}) {
  const [motion, motionHandlers] = useIconMotion()
  const Icon = item.icon
  const icon = Icon
    ? isAnimatedIcon(Icon)
      ? <Icon className="text-sidebar-foreground" motion={motion} />
      : <Icon className="text-sidebar-foreground" />
    : null

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild size="sm" tooltip={item.title} isActive={isActive}>
        {isExternal ? (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer"
            {...motionHandlers}
          >
            {icon}
            <span>{item.title}</span>
          </a>
        ) : (
          <Link to={item.url} className="cursor-pointer" {...motionHandlers}>
            {icon}
            <span>{item.title}</span>
          </Link>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
