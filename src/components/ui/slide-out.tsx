"use client"

import * as React from "react"
import { Sheet, SheetContent } from "./sheet"
import { cn } from "@/lib/utils"

interface SlideOutProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  subtitle?: string
  icon?: React.ReactNode
  side?: "right" | "left" | "top" | "bottom"
  className?: string
  headerClassName?: string
  contentClassName?: string
  children: React.ReactNode
}

export function SlideOut({
  open,
  onOpenChange,
  title,
  subtitle,
  icon,
  side = "right",
  className,
  headerClassName,
  contentClassName,
  children,
}: SlideOutProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        className={cn(
          // Mobile-first: full-width on small screens; constrain on larger
          "w-full max-w-full sm:max-w-[560px] px-4 sm:px-6 py-4 sm:py-6",
          className
        )}
      >
        <div className={cn("pb-4", headerClassName)}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {icon && (
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10">
                  {icon}
                </div>
              )}
              <div>
                <h2 className="text-lg font-semibold">{title}</h2>
                {subtitle ? (
                  <p className="text-xs text-muted-foreground">{subtitle}</p>
                ) : null}
              </div>
            </div>
          </div>
        </div>
        <div className={cn("pr-2", contentClassName)}>{children}</div>
      </SheetContent>
    </Sheet>
  )
}

export default SlideOut


