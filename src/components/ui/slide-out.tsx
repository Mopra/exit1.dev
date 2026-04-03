"use client"

import * as React from "react"
import { Sheet, SheetContent, SheetTitle } from "./sheet"
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
          "w-full max-w-full sm:max-w-lg md:max-w-xl p-0",
          className
        )}
      >
        <div className="p-7 sm:p-8">
          <div className={cn("pb-6", headerClassName)}>
            <div className="flex items-center gap-3">
              {icon && (
                <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-primary/10">
                  {icon}
                </div>
              )}
              <div>
                <SheetTitle className="text-lg font-semibold tracking-tight">{title}</SheetTitle>
                {subtitle ? (
                  <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
                ) : null}
              </div>
            </div>
          </div>
          <div className={cn(contentClassName)}>{children}</div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export default SlideOut


