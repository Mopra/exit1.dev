import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Contextual hover color utilities — all colors flow from theme tokens.
export const hoverColors = {
  blue: "hover:bg-primary/10 hover:border-primary/40",
  purple: "hover:bg-tier-nano/10 hover:border-tier-nano/40",
  green: "hover:bg-success/10 hover:border-success/40",
  red: "hover:bg-destructive/10 hover:border-destructive/40",
  orange: "hover:bg-warning/10 hover:border-warning/40",
  neutral: "hover:bg-muted/40 hover:border-border",
} as const

export type HoverColorVariant = keyof typeof hoverColors

// Table row hover variants based on context
export const tableHoverColors = {
  success: "hover:bg-success/10",
  error: "hover:bg-destructive/10",
  warning: "hover:bg-warning/10",
  info: "hover:bg-primary/10",
  neutral: "hover:bg-muted/40",
  default: "hover:bg-muted/50"
} as const

export type TableHoverVariant = keyof typeof tableHoverColors

export function getTableHoverColor(variant: TableHoverVariant = 'default'): string {
  return tableHoverColors[variant]
}
