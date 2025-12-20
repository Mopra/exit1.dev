import { Link, useLocation } from 'react-router-dom';
import { type LucideIcon } from "lucide-react"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export function NavMain({
  items,
  nano = false,
}: {
  items: {
    title: string
    url: string
    icon?: LucideIcon
    isAdmin?: boolean
  }[]
  nano?: boolean
}) {
  const location = useLocation();

  const isActivePath = (path: string) => {
    return location.pathname === path;
  };

  return (
    <SidebarGroup>
      <SidebarGroupContent className="flex flex-col gap-2">
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton 
                asChild
                tooltip={item.title}
                isActive={isActivePath(item.url)}
              >
                <Link to={item.url} className="cursor-pointer">
                  {item.icon && (
                    <item.icon
                      className={
                        item.isAdmin
                          ? "drop-shadow-[0_0_6px_rgba(56,189,248,0.6)] text-sky-400"
                          : nano
                            ? "drop-shadow-[0_0_6px_rgba(251,191,36,0.55)] text-amber-400"
                            : ""
                      }
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
