"use client"

import { type DateRange } from "react-day-picker"
import { CalendarIcon } from "lucide-react"

import { Calendar } from "@/components/ui/calendar"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

interface DateRangeCalendarProps {
  dateRange?: DateRange
  onDateRangeChange: (range: DateRange | undefined) => void
  className?: string
  placeholder?: string
}

export function DateRangeCalendar({
  dateRange,
  onDateRangeChange,
  className,
  placeholder = "Pick a date range"
}: DateRangeCalendarProps) {
  const formatDateRange = (range: DateRange | undefined) => {
    if (!range?.from) return placeholder
    
    if (!range.to) {
      return range.from.toLocaleDateString()
    }
    
    return `${range.from.toLocaleDateString()} - ${range.to.toLocaleDateString()}`
  }

  return (
    <div className={cn("grid gap-2", className)}>
      <Popover>
        <PopoverTrigger asChild>
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
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            defaultMonth={dateRange?.from}
            selected={dateRange}
            onSelect={onDateRangeChange}
            numberOfMonths={2}
            className="rounded-lg border shadow-sm"
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
