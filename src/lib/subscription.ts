export type SubscriptionPlanLike = {
  name?: string
  slug?: string
}

export type SubscriptionItemLike = {
  status?: string
  planPeriod?: "month" | "annual" | string
  plan?: SubscriptionPlanLike
}

export type SubscriptionLike = {
  subscriptionItems?: SubscriptionItemLike[]
}

function planText(plan: SubscriptionPlanLike | null | undefined) {
  return `${plan?.slug ?? ""} ${plan?.name ?? ""}`.trim().toLowerCase()
}

export function getActiveSubscriptionItems(subscription: SubscriptionLike | null | undefined) {
  const items = subscription?.subscriptionItems ?? []
  return items.filter((item) => {
    const status = (item?.status ?? "").toLowerCase()
    return status === "active" || status === "upcoming" || status === "past_due"
  })
}

export function getNanoSubscriptionItem(subscription: SubscriptionLike | null | undefined) {
  const items = getActiveSubscriptionItems(subscription)
  return (
    items.find((item) => planText(item.plan).includes("nano")) ??
    items.find((item) => planText(item.plan).includes("starter")) ??
    null
  )
}

export function isNanoPlan(subscription: SubscriptionLike | null | undefined) {
  return Boolean(getNanoSubscriptionItem(subscription))
}


