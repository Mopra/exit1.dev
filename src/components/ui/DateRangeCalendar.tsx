"use client"

import React from "react"
import { type DateRange } from "react-day-picker"
import { CalendarIcon } from "lucide-react"

import { Calendar } from "@/components/ui/calendar"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { cn } from "@/lib/utils"
import { useMobile } from "@/hooks/useMobile"

interface DateRangePreset {
  label: string
  getValue: () => DateRange
}

const getDateRangePresets = (maxRangeDays?: number): DateRangePreset[] => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  
  const presets: DateRangePreset[] = [
    {
      label: "Last 7 days",
      getValue: () => {
        const from = new Date(today)
        from.setDate(from.getDate() - 6)
        return { from, to: today }
      }
    },
    {
      label: "Last 14 days",
      getValue: () => {
        const from = new Date(today)
        from.setDate(from.getDate() - 13)
        return { from, to: today }
      }
    },
    {
      label: "Last 30 days",
      getValue: () => {
        const from = new Date(today)
        from.setDate(from.getDate() - 29)
        return { from, to: today }
      }
    },
    {
      label: "This month",
      getValue: () => {
        const from = new Date(today.getFullYear(), today.getMonth(), 1)
        return { from, to: today }
      }
    },
    {
      label: "Last month",
      getValue: () => {
        const from = new Date(today.getFullYear(), today.getMonth() - 1, 1)
        const to = new Date(today.getFullYear(), today.getMonth(), 0)
        return { from, to }
      }
    }
  ]
  
  // Filter presets that exceed maxRangeDays
  if (maxRangeDays) {
    return presets.filter(preset => {
      const range = preset.getValue()
      if (!range.from || !range.to) return true
      const dayMs = 24 * 60 * 60 * 1000
      const diffDays = Math.floor((range.to.getTime() - range.from.getTime()) / dayMs) + 1
      return diffDays <= maxRangeDays
    })
  }
  
  return presets
}

interface DateRangeCalendarProps {
  dateRange?: DateRange
  onDateRangeChange: (range: DateRange | undefined) => void
  className?: string
  placeholder?: string
  maxRangeDays?: number
}

export function DateRangeCalendar({
  dateRange,
  onDateRangeChange,
  className,
  placeholder = "Pick a date range",
  maxRangeDays
}: DateRangeCalendarProps) {
  const isMobile = useMobile(768)
  const [open, setOpen] = React.useState(false)
  const presets = React.useMemo(() => getDateRangePresets(maxRangeDays), [maxRangeDays])
  
  const formatDateRange = (range: DateRange | undefined) => {
    if (!range?.from) return placeholder
    
    if (!range.to) {
      return range.from.toLocaleDateString()
    }
    
    return `${range.from.toLocaleDateString()} - ${range.to.toLocaleDateString()}`
  }

  const clampRange = (range: DateRange | undefined): DateRange | undefined => {
    if (!maxRangeDays || !range?.from || !range?.to) return range
    const dayMs = 24 * 60 * 60 * 1000
    const diffDays = Math.floor((range.to.getTime() - range.from.getTime()) / dayMs) + 1
    if (diffDays <= maxRangeDays) return range
    const clampedTo = new Date(range.from.getTime() + (maxRangeDays - 1) * dayMs)
    return { from: range.from, to: clampedTo }
  }

  const maxSelectableDate = React.useMemo(() => {
    if (!maxRangeDays || !dateRange?.from) return undefined
    const dayMs = 24 * 60 * 60 * 1000
    return new Date(dateRange.from.getTime() + (maxRangeDays - 1) * dayMs)
  }, [dateRange?.from, maxRangeDays])

  const handleSelect = (range: DateRange | undefined) => {
    onDateRangeChange(clampRange(range))
    // Close drawer when a complete range is selected
    if (range?.from && range?.to) {
      setOpen(false)
    }
  }

  const handlePresetClick = (preset: DateRangePreset) => {
    const range = preset.getValue()
    onDateRangeChange(range)
    setOpen(false)
  }

  const presetsUI = (
    <div className="flex flex-wrap gap-2">
      {presets.map((preset) => (
        <Button
          key={preset.label}
          variant="outline"
          size="sm"
          onClick={() => handlePresetClick(preset)}
          className="text-xs"
        >
          {preset.label}
        </Button>
      ))}
    </div>
  )

  const triggerButton = (
    <Button
      id="date"
      variant="outline"
      size="sm"
      className={cn(
        "w-full justify-start text-left font-normal cursor-pointer",
        !dateRange && "text-muted-foreground"
      )}
    >
      <CalendarIcon className="mr-2 h-4 w-4" />
      {formatDateRange(dateRange)}
    </Button>
  )

  // Use Drawer on mobile for better UX
  if (isMobile) {
    return (
      <div className={cn("grid gap-2", className)}>
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerTrigger asChild>
            {triggerButton}
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Select date range</DrawerTitle>
            </DrawerHeader>
            <div className="p-4 pb-8 flex flex-col items-center gap-4">
              {presetsUI}
              <Calendar
                mode="range"
                defaultMonth={dateRange?.from}
                selected={dateRange}
                onSelect={handleSelect}
                disabled={maxSelectableDate ? { after: maxSelectableDate } : undefined}
                numberOfMonths={1}
                className="rounded-lg border"
              />
            </div>
          </DrawerContent>
        </Drawer>
      </div>
    )
  }

  // Use Popover on desktop
  return (
    <div className={cn("grid gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {triggerButton}
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <div className="flex flex-col gap-3 p-3">
            {presetsUI}
            <Calendar
              mode="range"
              defaultMonth={dateRange?.from}
              selected={dateRange}
              onSelect={handleSelect}
              disabled={maxSelectableDate ? { after: maxSelectableDate } : undefined}
              numberOfMonths={2}
              className="rounded-lg border shadow-sm"
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
