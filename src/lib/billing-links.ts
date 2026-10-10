/**
 * Link to the plan grid on the Billing page, optionally with one plan
 * preselected. Every upgrade prompt should use this so the user lands on the
 * plan the prompt named, not on a generic Billing overview.
 */
export function billingPlansHref(plan?: "free" | "indie" | "nano" | "pro" | null): string {
  return plan && plan !== "free" ? `/billing?tab=plans&plan=${plan}` : "/billing?tab=plans"
}
