import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Contextual hover color utilities
export const hoverColors = {
  blue: "hover:bg-primary/10 hover:border-primary/40",
  purple: "hover:bg-purple-50 dark:hover:bg-purple-950/20 hover:border-purple-300 dark:hover:border-purple-600",
  green: "hover:bg-green-50 dark:hover:bg-green-950/20 hover:border-green-300 dark:hover:border-green-600",
  red: "hover:bg-red-50 dark:hover:bg-red-950/20 hover:border-red-300 dark:hover:border-red-600",
  orange: "hover:bg-orange-50 dark:hover:bg-orange-950/20 hover:border-orange-300 dark:hover:border-orange-600",
  neutral: "hover:bg-gray-50 dark:hover:bg-gray-950/20 hover:border-gray-300 dark:hover:border-gray-600",
} as const

export type HoverColorVariant = keyof typeof hoverColors

export function getHoverColor(variant: HoverColorVariant): string {
  return hoverColors[variant]
}

// Table row hover variants based on context
export const tableHoverColors = {
  success: "hover:bg-green-50/50 dark:hover:bg-green-950/10",
  error: "hover:bg-red-50/50 dark:hover:bg-red-950/10", 
  warning: "hover:bg-orange-50/50 dark:hover:bg-orange-950/10",
  info: "hover:bg-primary/10",
  neutral: "hover:bg-gray-50/50 dark:hover:bg-gray-950/10",
  default: "hover:bg-muted/50"
} as const

export type TableHoverVariant = keyof typeof tableHoverColors

export function getTableHoverColor(variant: TableHoverVariant = 'default'): string {
  return tableHoverColors[variant]
}
