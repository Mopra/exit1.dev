import type { OrganizationBillingAddress, OrganizationBillingProfile } from "@/api/types"

// ---- internal helper ----

function normalizeProfileValue(value?: string | null) {
  if (!value) return undefined
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

// ---- public API ----

export function createEmptyOrganizationProfile(): OrganizationBillingProfile {
  return {
    companyName: "",
    legalName: "",
    email: "",
    phone: "",
    taxId: "",
    address: { line1: "", line2: "", city: "", region: "", postalCode: "", country: "" },
    customFields: {},
  }
}

export function buildOrganizationProfileState(
  profile: OrganizationBillingProfile | null | undefined,
): OrganizationBillingProfile {
  const empty = createEmptyOrganizationProfile()
  if (!profile) return empty
  return {
    ...empty,
    ...profile,
    address: { ...empty.address, ...(profile.address ?? {}) },
  }
}

export function normalizeOrganizationProfileForSave(
  profile: OrganizationBillingProfile,
): OrganizationBillingProfile | null {
  const address = profile.address ?? {}
  const normalizedAddress: OrganizationBillingAddress = {
    line1: normalizeProfileValue(address.line1),
    line2: normalizeProfileValue(address.line2),
    city: normalizeProfileValue(address.city),
    region: normalizeProfileValue(address.region),
    postalCode: normalizeProfileValue(address.postalCode),
    country: normalizeProfileValue(address.country),
  }
  const hasAddress = Object.values(normalizedAddress).some((v) => v)

  const customFields = profile.customFields ?? {}
  const normalizedCustomFields: Record<string, string> = {}
  Object.entries(customFields).forEach(([key, value]) => {
    const nk = normalizeProfileValue(key)
    const nv = normalizeProfileValue(value)
    if (nk && nv) normalizedCustomFields[nk] = nv
  })
  const hasCustomFields = Object.keys(normalizedCustomFields).length > 0

  const out: OrganizationBillingProfile = {
    companyName: normalizeProfileValue(profile.companyName),
    legalName: normalizeProfileValue(profile.legalName),
    email: normalizeProfileValue(profile.email),
    phone: normalizeProfileValue(profile.phone),
    taxId: normalizeProfileValue(profile.taxId),
    ...(hasAddress ? { address: normalizedAddress } : {}),
    ...(hasCustomFields ? { customFields: normalizedCustomFields } : {}),
  }

  const hasProfile = Boolean(
    out.companyName || out.legalName || out.email || out.phone || out.taxId || out.address || out.customFields,
  )
  return hasProfile ? out : null
}

export function parseOrganizationBillingProfile(
  metadata: Record<string, unknown> | null | undefined,
): OrganizationBillingProfile | null {
  if (!metadata) return null
  const raw = (metadata as { billingProfile?: unknown }).billingProfile
  if (!raw || typeof raw !== "object") return null

  const record = raw as Record<string, unknown>
  const rv = (v: unknown) => (typeof v === "string" ? normalizeProfileValue(v) : undefined)

  let address: OrganizationBillingAddress | undefined
  if (record.address && typeof record.address === "object") {
    const a = record.address as Record<string, unknown>
    const parsed: OrganizationBillingAddress = {
      line1: rv(a.line1),
      line2: rv(a.line2),
      city: rv(a.city),
      region: rv(a.region),
      postalCode: rv(a.postalCode),
      country: rv(a.country),
    }
    if (Object.values(parsed).some((v) => v)) address = parsed
  }

  let customFields: Record<string, string> | undefined
  if (record.customFields && typeof record.customFields === "object") {
    const cfr = record.customFields as Record<string, unknown>
    const parsed: Record<string, string> = {}
    Object.entries(cfr).forEach(([k, v]) => {
      const nv = rv(v)
      if (nv) parsed[k] = nv
    })
    if (Object.keys(parsed).length > 0) customFields = parsed
  }

  const profile: OrganizationBillingProfile = {
    companyName: rv(record.companyName),
    legalName: rv(record.legalName),
    email: rv(record.email),
    phone: rv(record.phone),
    taxId: rv(record.taxId),
    taxIdLabel: rv(record.taxIdLabel),
    ...(address ? { address } : {}),
    ...(customFields ? { customFields } : {}),
  }

  const hasProfile = Boolean(
    profile.companyName || profile.legalName || profile.email || profile.phone || profile.taxId || profile.address || profile.customFields,
  )
  return hasProfile ? profile : null
}

export function validateVatId(vatId: string): string | undefined {
  if (!vatId.trim()) return undefined
  const pattern = /^[A-Z]{2}[A-Z0-9]{2,12}$/i
  if (!pattern.test(vatId.trim())) {
    return "VAT ID must start with a 2-letter country code followed by alphanumeric characters (e.g., DK46156153)"
  }
  return undefined
}
