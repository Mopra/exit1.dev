"use client"

import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "../../lib/utils"

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2 min-w-0", className)}
      {...props}
    />
  )
}

/**
 * The active tab's pill is one element that slides between triggers instead
 * of each trigger painting its own background. It is measured from the
 * active trigger (Radix marks it data-state="active"), and re-measured when
 * the active tab or the list's size changes. Until it has measured, and
 * without JS, triggers paint their own pill as before; `data-indicator` on
 * the list hands that job to the slider (see motion.css).
 */
function useTabsIndicator() {
  const listRef = React.useRef<HTMLDivElement>(null)
  const [box, setBox] = React.useState<{ left: number; top: number; width: number; height: number } | null>(null)

  React.useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = () => {
      const active = list.querySelector<HTMLElement>('[data-slot="tabs-trigger"][data-state="active"]')
      const next = active
        ? { left: active.offsetLeft, top: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight }
        : null
      setBox((cur) =>
        cur && next && cur.left === next.left && cur.top === next.top && cur.width === next.width && cur.height === next.height
          ? cur
          : next)
    }
    measure()
    const mo = new MutationObserver(measure)
    mo.observe(list, { subtree: true, attributes: true, attributeFilter: ["data-state"], childList: true })
    const ro = new ResizeObserver(measure)
    ro.observe(list)
    return () => {
      mo.disconnect()
      ro.disconnect()
    }
  }, [])

  return { listRef, box }
}

function TabsList({
  className,
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  const { listRef, box } = useTabsIndicator()
  // Slide between tabs, but appear in place the first time it is measured.
  const moved = React.useRef(false)
  React.useEffect(() => {
    if (box) moved.current = true
  }, [box])

  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-indicator={box ? "" : undefined}
      className={cn(
        "relative inline-flex h-10 w-full sm:w-fit items-center justify-start sm:justify-center gap-0.5 sm:gap-1 rounded-lg p-0.5 sm:p-1 bg-muted/60 text-muted-foreground backdrop-blur supports-[backdrop-filter]:bg-muted/40 overflow-x-auto flex-nowrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
      {...props}
      ref={listRef}
    >
      {box && (
        <span
          data-slot="tabs-indicator"
          aria-hidden
          className={cn(
            "pointer-events-none absolute rounded-md border border-transparent bg-background shadow-sm dark:border-input dark:bg-input/30",
            moved.current && "transition-[left,top,width,height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          )}
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
      {children}
    </TabsPrimitive.List>
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-[calc(100%-1px)] sm:flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-3 py-2 min-w-[5.5rem] text-sm font-medium whitespace-nowrap cursor-pointer text-foreground dark:text-muted-foreground transition-colors focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:[animation-duration:200ms]", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent } 