import { useEffect, useMemo, useState, useRef, type ComponentProps } from "react"
import {
  OrganizationSwitcher,
  PricingTable,
  SignedIn,
  SignedOut,
  useClerk,
  useOrganizationList,
  useOrganization,
  useUser,
} from "@clerk/clerk-react"
import {
  SubscriptionDetailsButton,
  usePaymentAttempts,
  usePaymentMethods,
} from "@clerk/clerk-react/experimental"
import { CreditCard, RefreshCw, Sparkles, Plus, Trash2, Receipt, Building2, FileText, CheckCircle2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { PageContainer, PageHeader, DocsLink } from "@/components/layout"
import { apiClient } from "@/api/client"
import type { OrganizationBillingAddress, OrganizationBillingProfile } from "@/api/types"
import { useNanoPlan } from "@/hooks/useNanoPlan"
import receiptConfig from "@/config/receipt.json"

function formatDate(date: Date | null | undefined) {
  if (!date) return "—"
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
    }).format(date)
  } catch {
    return date.toLocaleDateString()
  }
}

function getStatusVariant(
  status: string | null | undefined
): ComponentProps<typeof Badge>["variant"] {
  switch (status) {
    case "active":
      return "success"
    case "past_due":
      return "warning"
    case "canceled":
    case "unpaid":
      return "error"
    default:
      return "secondary"
  }
}

function getPaymentStatusVariant(
  status: string | null | undefined
): ComponentProps<typeof Badge>["variant"] {
  switch (status) {
    case "paid":
      return "success"
    case "pending":
      return "warning"
    case "failed":
      return "error"
    default:
      return "secondary"
  }
}

function formatMoney(
  amount: { amountFormatted: string; currencySymbol?: string | null } | null | undefined
) {
  if (!amount) return "N/A"
  const symbol = amount.currencySymbol ?? ""
  return symbol ? `${symbol}${amount.amountFormatted}` : amount.amountFormatted
}

function validateVatId(vatId: string): string | undefined {
  if (!vatId.trim()) return undefined // Empty is valid (optional field)
  
  // VAT ID must start with 2-letter country code followed by alphanumeric characters
  // Format: CC123456789 (e.g., DK46156153, GB123456789, DE123456789)
  const vatIdPattern = /^[A-Z]{2}[A-Z0-9]{2,12}$/i
  const trimmed = vatId.trim()
  
  if (!vatIdPattern.test(trimmed)) {
    return "VAT ID must start with a 2-letter country code followed by alphanumeric characters (e.g., DK46156153)"
  }
  
  return undefined
}

type BillingRecipient = {
  name: string
  email: string
  legalName?: string
  phone?: string
  addressLines?: string[]
  taxId?: string
  taxIdLabel?: string
  customFields?: Record<string, string>
  isOrganization?: boolean
}

function createEmptyOrganizationProfile(): OrganizationBillingProfile {
  return {
    companyName: "",
    legalName: "",
    email: "",
    phone: "",
    taxId: "",
    address: {
      line1: "",
      line2: "",
      city: "",
      region: "",
      postalCode: "",
      country: "",
    },
    customFields: {},
  }
}

function normalizeProfileValue(value?: string | null) {
  if (!value) return undefined
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

function buildOrganizationProfileState(
  profile: OrganizationBillingProfile | null | undefined
): OrganizationBillingProfile {
  const empty = createEmptyOrganizationProfile()
  if (!profile) return empty
  return {
    ...empty,
    ...profile,
    address: {
      ...empty.address,
      ...(profile.address ?? {}),
    },
  }
}

function normalizeOrganizationProfileForSave(
  profile: OrganizationBillingProfile
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
  const hasAddress = Object.values(normalizedAddress).some((value) => value)

  const customFields = profile.customFields ?? {}
  const normalizedCustomFields: Record<string, string> = {}
  Object.entries(customFields).forEach(([key, value]) => {
    const normalizedKey = normalizeProfileValue(key)
    const normalizedValue = normalizeProfileValue(value)
    if (normalizedKey && normalizedValue) {
      normalizedCustomFields[normalizedKey] = normalizedValue
    }
  })
  const hasCustomFields = Object.keys(normalizedCustomFields).length > 0

  const normalizedProfile: OrganizationBillingProfile = {
    companyName: normalizeProfileValue(profile.companyName),
    legalName: normalizeProfileValue(profile.legalName),
    email: normalizeProfileValue(profile.email),
    phone: normalizeProfileValue(profile.phone),
    taxId: normalizeProfileValue(profile.taxId),
    ...(hasAddress ? { address: normalizedAddress } : {}),
    ...(hasCustomFields ? { customFields: normalizedCustomFields } : {}),
  }

  const hasProfile = Boolean(
    normalizedProfile.companyName ||
      normalizedProfile.legalName ||
      normalizedProfile.email ||
      normalizedProfile.phone ||
      normalizedProfile.taxId ||
      normalizedProfile.address ||
      normalizedProfile.customFields
  )

  return hasProfile ? normalizedProfile : null
}

function parseOrganizationBillingProfile(
  metadata: Record<string, unknown> | null | undefined
): OrganizationBillingProfile | null {
  if (!metadata) return null
  const rawProfile = (metadata as { billingProfile?: unknown }).billingProfile
  if (!rawProfile || typeof rawProfile !== "object") return null

  const record = rawProfile as Record<string, unknown>
  const readValue = (value: unknown) =>
    typeof value === "string" ? normalizeProfileValue(value) : undefined

  let address: OrganizationBillingAddress | undefined
  if (record.address && typeof record.address === "object") {
    const addressRecord = record.address as Record<string, unknown>
    const parsedAddress: OrganizationBillingAddress = {
      line1: readValue(addressRecord.line1),
      line2: readValue(addressRecord.line2),
      city: readValue(addressRecord.city),
      region: readValue(addressRecord.region),
      postalCode: readValue(addressRecord.postalCode),
      country: readValue(addressRecord.country),
    }
    if (Object.values(parsedAddress).some((value) => value)) {
      address = parsedAddress
    }
  }

  let customFields: Record<string, string> | undefined
  if (record.customFields && typeof record.customFields === "object") {
    const customFieldsRecord = record.customFields as Record<string, unknown>
    const parsed: Record<string, string> = {}
    Object.entries(customFieldsRecord).forEach(([key, value]) => {
      const normalizedValue = readValue(value)
      if (normalizedValue) {
        parsed[key] = normalizedValue
      }
    })
    if (Object.keys(parsed).length > 0) {
      customFields = parsed
    }
  }

  const profile: OrganizationBillingProfile = {
    companyName: readValue(record.companyName),
    legalName: readValue(record.legalName),
    email: readValue(record.email),
    phone: readValue(record.phone),
    taxId: readValue(record.taxId),
    taxIdLabel: readValue(record.taxIdLabel),
    ...(address ? { address } : {}),
    ...(customFields ? { customFields } : {}),
  }

  const hasProfile = Boolean(
    profile.companyName ||
      profile.legalName ||
      profile.email ||
      profile.phone ||
      profile.taxId ||
      profile.address ||
      profile.customFields
  )

  return hasProfile ? profile : null
}

function buildOrganizationAddressLines(
  address: OrganizationBillingAddress | null | undefined
) {
  if (!address) return []
  const cityRegion = [address.city, address.region].filter(Boolean).join(", ")
  const postalCountry = [address.postalCode, address.country].filter(Boolean).join(" ")
  return [address.line1, address.line2, cityRegion, postalCountry].filter(
    (line): line is string => Boolean(line && line.trim().length > 0)
  )
}

function buildRecipientLines(recipient: BillingRecipient) {
  if (!recipient.isOrganization) {
    return [`Name: ${recipient.name}`, `Email: ${recipient.email}`]
  }

  const lines: string[] = [`Company: ${recipient.name}`]
  if (recipient.legalName && recipient.legalName !== recipient.name) {
    lines.push(`Legal name: ${recipient.legalName}`)
  }
  if (recipient.addressLines?.length) {
    lines.push(...recipient.addressLines)
  }
  if (recipient.email) {
    lines.push(`Email: ${recipient.email}`)
  }
  if (recipient.phone) {
    lines.push(`Phone: ${recipient.phone}`)
  }
  if (recipient.taxId) {
    lines.push(`VAT ID: ${recipient.taxId}`)
  }
  if (recipient.customFields) {
    Object.entries(recipient.customFields).forEach(([key, value]) => {
      if (value?.trim()) {
        lines.push(`${key}: ${value}`)
      }
    })
  }
  return lines
}

type ReceiptConfig = {
  seller?: {
    displayName?: string
    legalName?: string
    email?: string
    website?: string
    phone?: string
    address?: {
      line1?: string
      line2?: string
      city?: string
      region?: string
      postalCode?: string
      country?: string
    }
  }
  tax?: {
    taxId?: string
    taxIdLabel?: string
  }
  receipt?: {
    statement?: string
    footerNote?: string
    disclaimer?: string
  }
  style?: {
    accentColor?: string
    logoText?: string
    receiptTitle?: string
  }
}

const RECEIPT_CONFIG = receiptConfig as ReceiptConfig
const SELLER = RECEIPT_CONFIG.seller ?? {}
const SELLER_ADDRESS = SELLER.address ?? {}

const PDF_ISSUER = {
  name: SELLER.displayName || SELLER.legalName || "Exit1.dev",
  legalName: SELLER.legalName || SELLER.displayName || "Exit1.dev",
  email: SELLER.email || "support@exit1.dev",
  website: SELLER.website || "https://exit1.dev",
  phone: SELLER.phone,
  addressLines: [
    SELLER_ADDRESS.line1,
    SELLER_ADDRESS.line2,
    [SELLER_ADDRESS.city, SELLER_ADDRESS.region].filter(Boolean).join(", "),
    [SELLER_ADDRESS.postalCode, SELLER_ADDRESS.country].filter(Boolean).join(" ")
  ].filter((line) => line && line.trim().length > 0),
  taxId: RECEIPT_CONFIG.tax?.taxId,
}

const PDF_STYLE = RECEIPT_CONFIG.style ?? {}
const PDF_BRAND = PDF_STYLE.logoText || PDF_ISSUER.name
const PDF_RECEIPT_TITLE = PDF_STYLE.receiptTitle || "Payment receipt"
const PDF_ACCENT_HEX = PDF_STYLE.accentColor || "#2563eb"

const PDF_STATEMENT =
  RECEIPT_CONFIG.receipt?.statement || "Digital service subscription receipt."
const PDF_FOOTER_NOTE =
  RECEIPT_CONFIG.receipt?.footerNote || "Thank you for your business."
const PDF_DISCLAIMER = RECEIPT_CONFIG.receipt?.disclaimer

function formatDatePdf(date: Date | null | undefined) {
  if (!date) return "N/A"
  return date.toISOString().slice(0, 10)
}

function formatMoneyPdf(
  amount: { amountFormatted: string; currency?: string | null } | null | undefined
) {
  if (!amount) return "N/A"
  const currency = amount.currency ?? "USD"
  return `${currency} ${amount.amountFormatted}`
}

function sanitizePdfText(value: string) {
  const normalized = Array.from(value).map((char) => {
    const code = char.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return " "
    if (code <= 255) return char
    return "?"
  })
  return normalized.join("")
}

function encodePdfLiteralString(value: string) {
  const sanitized = sanitizePdfText(value)
  const bytes: number[] = []
  for (const char of sanitized) {
    bytes.push(char.codePointAt(0) ?? 63)
  }

  return bytes
    .map((byte) => {
      if (byte === 0x28) return "\\("
      if (byte === 0x29) return "\\)"
      if (byte === 0x5c) return "\\\\"
      if (byte >= 0x20 && byte <= 0x7e) {
        return String.fromCharCode(byte)
      }
      return `\\${byte.toString(8).padStart(3, "0")}`
    })
    .join("")
}

function escapePdfText(value: string) {
  return encodePdfLiteralString(value)
}

function wrapPdfText(value: string, maxLength: number) {
  const sanitized = sanitizePdfText(value).trim()
  if (sanitized.length <= maxLength) return [sanitized]

  const words = sanitized.split(" ")
  const lines: string[] = []
  let current = ""

  for (const word of words) {
    if (!current) {
      current = word
      continue
    }

    if ((current + " " + word).length > maxLength) {
      lines.push(current)
      current = word
    } else {
      current = `${current} ${word}`
    }
  }

  if (current) lines.push(current)
  return lines
}

function hexToRgb(hex: string) {
  const cleaned = hex.trim().replace(/^#/, "")
  const valid = cleaned.length === 3 || cleaned.length === 6
  if (!valid) return null

  const full = cleaned.length === 3
    ? cleaned.split("").map((c) => c + c).join("")
    : cleaned
  const value = Number.parseInt(full, 16)
  if (Number.isNaN(value)) return null

  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
  }
}

function pdfColorFromHex(hex: string, fallback: string) {
  const rgb = hexToRgb(hex)
  if (!rgb) return fallback
  return `${rgb.r.toFixed(3)} ${rgb.g.toFixed(3)} ${rgb.b.toFixed(3)}`
}

const PDF_COLORS = {
  accent: pdfColorFromHex(PDF_ACCENT_HEX, "0.145 0.388 0.922"),
  text: "0 0 0",
  muted: "0.35 0.35 0.35",
  line: "0.86 0.86 0.86",
  subtleFill: "0.96 0.96 0.96",
}

function measureTextWidth(text: string, size: number) {
  return text.length * size * 0.52
}

type PdfTextOptions = {
  size?: number
  font?: "F1" | "F2"
  color?: string
  align?: "left" | "right"
}

function pdfText(text: string, x: number, y: number, options?: PdfTextOptions) {
  const size = options?.size ?? 11
  const font = options?.font ?? "F1"
  const color = options?.color ?? PDF_COLORS.text
  const width = measureTextWidth(text, size)
  const finalX = options?.align === "right" ? x - width : x
  return `BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${finalX.toFixed(
    2
  )} ${y.toFixed(2)} Tm (${escapePdfText(text)}) Tj ET`
}

function pdfLine(x1: number, y1: number, x2: number, y2: number, color: string, width: number) {
  return `${color} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(
    2
  )} ${y2.toFixed(2)} l S`
}

function pdfFillRect(
  x: number,
  y: number,
  width: number,
  height: number,
  color: string
) {
  return `${color} rg ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(
    2
  )} ${height.toFixed(2)} re f`
}

function pushWrappedText(
  commands: string[],
  text: string,
  x: number,
  y: number,
  maxLength: number,
  options?: PdfTextOptions
) {
  const size = options?.size ?? 11
  const lineHeight = size + 3
  const lines = wrapPdfText(text, maxLength)
  let cursor = y

  for (const line of lines) {
    commands.push(pdfText(line, x, cursor, options))
    cursor -= lineHeight
  }

  return cursor
}

function formatStatusLabel(status: string | null | undefined) {
  if (!status) return "N/A"
  return status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function buildPdf(commands: string[]) {
  const contentStream = commands.join("\n")

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n",
    "6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n",
  ]

  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []

  for (const obj of objects) {
    offsets.push(pdf.length)
    pdf += obj
  }

  const xrefStart = pdf.length
  const xrefEntries = ["0000000000 65535 f \n"]
  for (const offset of offsets) {
    xrefEntries.push(`${String(offset).padStart(10, "0")} 00000 n \n`)
  }

  pdf += `xref\n0 ${objects.length + 1}\n${xrefEntries.join("")}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  return new Blob([new TextEncoder().encode(pdf)], { type: "application/pdf" })
}

function downloadPdf(filename: string, commands: string[]) {
  const safeName = sanitizePdfText(filename.replace(/[^a-zA-Z0-9-_.]/g, "_"))
  const blob = buildPdf(commands)
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = safeName
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function Billing() {
  const { subscription, nano, nanoItem, isLoading, isFetching, error, revalidate } = useNanoPlan()
  const { data: paymentMethods, isLoading: isPaymentMethodsLoading } =
    usePaymentMethods({ for: "user" })
  const {
    data: paymentAttempts,
    isLoading: isPaymentAttemptsLoading,
    isFetching: isPaymentAttemptsFetching,
    error: paymentAttemptsError,
    fetchNext: fetchNextPaymentAttempts,
    hasNextPage: hasNextPaymentAttempts,
  } = usePaymentAttempts({ for: "user", pageSize: 6 })
  const { user } = useUser()
  const { organization } = useOrganization()
  const { isLoaded: isOrgListLoaded, setActive, userMemberships } =
    useOrganizationList({
      userMemberships: { infinite: true },
    })
  const { openCreateOrganization, openOrganizationProfile } = useClerk()
  const showPaidTabs = nano
  const defaultTab = showPaidTabs ? "subscription" : "plans"
  const [organizationProfile, setOrganizationProfile] = useState<OrganizationBillingProfile>(
    () => createEmptyOrganizationProfile()
  )
  const [savedOrganizationProfile, setSavedOrganizationProfile] =
    useState<OrganizationBillingProfile | null>(null)
  const [isSavingOrganization, setIsSavingOrganization] = useState(false)
  const [organizationSaveError, setOrganizationSaveError] = useState<string | null>(null)
  const [organizationSaveSuccess, setOrganizationSaveSuccess] = useState<string | null>(null)
  const [taxIdError, setTaxIdError] = useState<string | undefined>(undefined)
  const justSavedRef = useRef<boolean>(false)

  useEffect(() => {
    // Skip reset if we just saved - the save handler already updated the state
    if (justSavedRef.current) {
      justSavedRef.current = false
      return
    }
    
    if (!organization) {
      setOrganizationProfile(createEmptyOrganizationProfile())
      setSavedOrganizationProfile(null)
      setOrganizationSaveError(null)
      setOrganizationSaveSuccess(null)
      return
    }

    const metadata = organization.publicMetadata as
      | Record<string, unknown>
      | null
      | undefined
    const profile = parseOrganizationBillingProfile(metadata)
    setOrganizationProfile(buildOrganizationProfileState(profile))
    setSavedOrganizationProfile(profile)
    setOrganizationSaveError(null)
    setOrganizationSaveSuccess(null)
  }, [organization?.id, organization?.publicMetadata])
  const personalRecipient = useMemo<BillingRecipient>(() => {
    const email = user?.primaryEmailAddress?.emailAddress ?? "N/A"
    const name =
      user?.fullName ??
      (user?.primaryEmailAddress?.emailAddress
        ? user.primaryEmailAddress.emailAddress
        : "Customer")
    return { name, email }
  }, [user])
  const organizationRecipient = useMemo<BillingRecipient | null>(() => {
    if (!nano || !organization) return null
    const profile = savedOrganizationProfile
    const companyName = profile?.companyName || organization.name
    const legalName = profile?.legalName
    const email = profile?.email || personalRecipient.email
    const phone = profile?.phone
    const addressLines = buildOrganizationAddressLines(profile?.address)
    const taxId = profile?.taxId
    const customFields = profile?.customFields

    return {
      isOrganization: true,
      name: companyName,
      legalName,
      email,
      phone,
      addressLines,
      taxId,
      customFields,
    }
  }, [nano, organization, personalRecipient, savedOrganizationProfile])
  const billingRecipient = organizationRecipient ?? personalRecipient

  const nextPayment = subscription?.nextPayment
  const paymentMethodSummary = useMemo(() => {
    if (isPaymentMethodsLoading) return "Loading…"
    if (!paymentMethods || paymentMethods.length === 0) return "None on file"
    const cards = paymentMethods
      .map((m) => `${m.cardType} •••• ${m.last4}`)
      .slice(0, 2)
      .join(", ")
    return paymentMethods.length > 2 ? `${cards} +${paymentMethods.length - 2}` : cards
  }, [isPaymentMethodsLoading, paymentMethods])

  const paymentAttemptItems = paymentAttempts ?? []
  const organizationAddress: OrganizationBillingAddress =
    organizationProfile.address ?? {}
  const organizationMemberships = userMemberships.data ?? []
  const hasOrganizations = isOrgListLoaded && organizationMemberships.length > 0
  const primaryOrganization = organizationMemberships[0]?.organization

  const setOrganizationField = (
    field: keyof OrganizationBillingProfile,
    value: string
  ) => {
    setOrganizationProfile((current) => ({ ...current, [field]: value }))
    setOrganizationSaveError(null)
    setOrganizationSaveSuccess(null)
    
    // Validate VAT ID when field is taxId
    if (field === "taxId") {
      const error = validateVatId(value)
      setTaxIdError(error)
    }
  }

  const setOrganizationAddressField = (
    field: keyof OrganizationBillingAddress,
    value: string
  ) => {
    setOrganizationProfile((current) => ({
      ...current,
      address: {
        ...(current.address ?? {}),
        [field]: value,
      },
    }))
    setOrganizationSaveError(null)
    setOrganizationSaveSuccess(null)
  }

  const handleSaveOrganizationProfile = async () => {
    if (!organization) return
    
    // Validate VAT ID before saving
    const vatIdError = validateVatId(organizationProfile.taxId ?? "")
    if (vatIdError) {
      setTaxIdError(vatIdError)
      setOrganizationSaveError("Please fix the validation errors before saving.")
      return
    }
    
    setIsSavingOrganization(true)
    setOrganizationSaveError(null)
    setOrganizationSaveSuccess(null)

    const normalizedProfile = normalizeOrganizationProfileForSave(organizationProfile)

    try {
      const result = await apiClient.updateOrganizationBillingProfile(
        organization.id,
        normalizedProfile
      )
      if (!result.success) {
        setOrganizationSaveError(
          result.error || "Failed to update organization billing profile"
        )
        return
      }

      // Set flag to prevent useEffect from resetting form before Clerk metadata updates
      justSavedRef.current = true
      
      setSavedOrganizationProfile(normalizedProfile)
      setOrganizationProfile(buildOrganizationProfileState(normalizedProfile))
      setOrganizationSaveSuccess("Organization billing details saved.")
    } finally {
      setIsSavingOrganization(false)
    }
  }

  const handleResetOrganizationProfile = () => {
    setOrganizationProfile(buildOrganizationProfileState(savedOrganizationProfile))
    setOrganizationSaveError(null)
    setOrganizationSaveSuccess(null)
  }

  const buildPaymentPdfCommands = (payment: (typeof paymentAttemptItems)[number]) => {
    const commands: string[] = []
    const pageWidth = 612
    const pageHeight = 792
    const margin = 54
    const rightEdge = pageWidth - margin
    const rightColX = 330

    const method = payment.paymentMethod?.last4
      ? `${payment.paymentMethod.cardType} **** ${payment.paymentMethod.last4}`
      : "No payment method"
    const planName =
      payment.subscriptionItem?.plan?.name ??
      payment.subscriptionItem?.plan?.slug ??
      "Exit1.dev subscription"
    const planPeriod =
      payment.subscriptionItem?.planPeriod === "annual"
        ? "Annual"
        : payment.subscriptionItem?.planPeriod === "month"
          ? "Monthly"
          : "One-time"
    const chargeLabel =
      payment.chargeType === "recurring"
        ? "Subscription payment"
        : payment.chargeType === "checkout"
          ? "Checkout payment"
          : "Payment"

    let y = pageHeight - margin

    commands.push(pdfText(PDF_BRAND, margin, y, { size: 20, font: "F2" }))
    commands.push(
      pdfText(PDF_RECEIPT_TITLE, rightEdge, y, {
        size: 18,
        font: "F2",
        align: "right",
      })
    )
    y -= 20
    const statementStart = y
    y = pushWrappedText(commands, PDF_STATEMENT, margin, y, 70, {
      size: 10,
      color: PDF_COLORS.muted,
    })
    commands.push(
      pdfText(`Status: ${formatStatusLabel(payment.status)}`, rightEdge, statementStart, {
        size: 10,
        color: PDF_COLORS.accent,
        align: "right",
      })
    )
    y -= 4
    commands.push(pdfLine(margin, y, rightEdge, y, PDF_COLORS.line, 1))
    y -= 18

    const sellerStart = y
    commands.push(pdfText("Seller", margin, y, { size: 11, font: "F2", color: PDF_COLORS.accent }))
    let leftY = y - 14
    const sellerLines = [
      PDF_ISSUER.legalName,
      ...PDF_ISSUER.addressLines,
      PDF_ISSUER.email,
      PDF_ISSUER.phone,
      PDF_ISSUER.taxId ? `VAT ID: ${PDF_ISSUER.taxId}` : "",
    ].filter((line): line is string => Boolean(line))
    for (const line of sellerLines) {
      leftY = pushWrappedText(commands, line, margin, leftY, 42, { size: 10 })
    }

    let rightY = sellerStart
    commands.push(
      pdfText("Receipt details", rightColX, rightY, {
        size: 11,
        font: "F2",
        color: PDF_COLORS.accent,
      })
    )
    rightY -= 14
    const receiptDate = formatDatePdf(payment.paidAt ?? payment.updatedAt)
    const detailLines = [
      `Receipt ID: ${payment.id}`,
      `Date: ${receiptDate}`,
      `Amount: ${formatMoneyPdf(payment.amount)}`,
      `Charge: ${chargeLabel}`,
      `Method: ${method}`,
    ]
    for (const line of detailLines) {
      rightY = pushWrappedText(commands, line, rightColX, rightY, 36, { size: 10 })
    }

    y = Math.min(leftY, rightY) - 12

    commands.push(pdfText("Billed to", margin, y, { size: 11, font: "F2", color: PDF_COLORS.accent }))
    y -= 14
    const recipientLines = buildRecipientLines(billingRecipient)
    for (const line of recipientLines) {
      y = pushWrappedText(commands, line, margin, y, 50, { size: 10 })
    }
    y -= 10

    commands.push(pdfText("Item", margin, y, { size: 11, font: "F2" }))
    commands.push(pdfText("Amount", rightEdge, y, { size: 11, font: "F2", align: "right" }))
    y -= 8
    commands.push(pdfLine(margin, y, rightEdge, y, PDF_COLORS.line, 1))
    y -= 14

    const description = `${planName} (${planPeriod})`
    const descriptionLines = wrapPdfText(description, 60)
    const itemStartY = y
    descriptionLines.forEach((line, index) => {
      commands.push(pdfText(line, margin, itemStartY - index * 14, { size: 11 }))
    })
    commands.push(
      pdfText(formatMoneyPdf(payment.amount), rightEdge, itemStartY, {
        size: 12,
        font: "F2",
        align: "right",
      })
    )
    y = itemStartY - descriptionLines.length * 14 - 4
    commands.push(pdfText(chargeLabel, margin, y, { size: 10, color: PDF_COLORS.muted }))
    y -= 16
    commands.push(
      pdfText(`Payment method: ${method}`, margin, y, { size: 10, color: PDF_COLORS.muted })
    )
    y -= 18

    const boxWidth = 200
    const boxHeight = 48
    const boxX = rightEdge - boxWidth
    const boxY = y - boxHeight
    commands.push(pdfFillRect(boxX, boxY, boxWidth, boxHeight, PDF_COLORS.subtleFill))
    commands.push(
      pdfLine(boxX, boxY + boxHeight, boxX + boxWidth, boxY + boxHeight, PDF_COLORS.line, 1)
    )
    commands.push(
      pdfText("Total paid", boxX + 12, boxY + boxHeight - 16, {
        size: 10,
        color: PDF_COLORS.muted,
      })
    )
    commands.push(
      pdfText(formatMoneyPdf(payment.amount), boxX + boxWidth - 12, boxY + 16, {
        size: 14,
        font: "F2",
        align: "right",
      })
    )

    let footerY = Math.max(60, boxY - 24)
    if (PDF_DISCLAIMER) {
      footerY = pushWrappedText(commands, PDF_DISCLAIMER, margin, footerY, 80, {
        size: 9,
        color: PDF_COLORS.muted,
      }) - 8
    }
    commands.push(pdfText(PDF_FOOTER_NOTE, margin, footerY, { size: 9, color: PDF_COLORS.muted }))

    return commands
  }

  const handleDownloadPaymentPdf = (payment: (typeof paymentAttemptItems)[number]) => {
    downloadPdf(`exit1-payment-${payment.id}.pdf`, buildPaymentPdfCommands(payment))
  }

  return (
    <PageContainer>
      <PageHeader
        title="Billing"
        description="Manage your subscription, payment methods, and billing history"
        icon={CreditCard}
        actions={
          <div className="flex items-center gap-2">
            <DocsLink path="/billing" label="Billing docs" />
            <SignedIn>
              <Button
                variant="outline"
                onClick={() => void revalidate()}
                disabled={isLoading}
                className="cursor-pointer gap-2"
                title="Refresh billing data"
              >
                <RefreshCw className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                <span className="hidden sm:inline">Refresh</span>
              </Button>
            </SignedIn>
          </div>
        }
      />

      <div className="flex-1 overflow-auto w-full" style={{ scrollbarGutter: 'stable' }}>
        <div className="w-full mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
          <SignedOut>
            <Card className="bg-card border-0 shadow-lg">
              <CardHeader className="p-6 lg:p-8">
                <CardTitle className="text-xl">Sign in required</CardTitle>
                <CardDescription>
                  Please sign in to manage billing settings.
                </CardDescription>
              </CardHeader>
            </Card>
          </SignedOut>

          <SignedIn>
            <Tabs key={showPaidTabs ? "paid" : "free"} defaultValue={defaultTab} className="w-full">
              <TabsList className="w-full sm:w-fit mb-6">
                {showPaidTabs && (
                  <TabsTrigger value="subscription" className="cursor-pointer min-w-0 sm:min-w-[5.5rem] px-2 sm:px-3 touch-manipulation">
                    <CreditCard className="w-4 h-4 flex-shrink-0" />
                    <span className="hidden sm:inline">Subscription</span>
                  </TabsTrigger>
                )}
                {showPaidTabs && (
                  <TabsTrigger value="payment-methods" className="cursor-pointer min-w-0 sm:min-w-[5.5rem] px-2 sm:px-3 touch-manipulation">
                    <CreditCard className="w-4 h-4 flex-shrink-0" />
                    <span className="hidden sm:inline">Payment</span>
                  </TabsTrigger>
                )}
                {showPaidTabs && (
                  <TabsTrigger value="history" className="cursor-pointer min-w-0 sm:min-w-[5.5rem] px-2 sm:px-3 touch-manipulation">
                    <Receipt className="w-4 h-4 flex-shrink-0" />
                    <span className="hidden sm:inline">History</span>
                  </TabsTrigger>
                )}
                {showPaidTabs && (
                  <TabsTrigger value="organization" className="cursor-pointer min-w-0 sm:min-w-[5.5rem] px-2 sm:px-3 touch-manipulation">
                    <Building2 className="w-4 h-4 flex-shrink-0" />
                    <span className="hidden sm:inline">Organization</span>
                  </TabsTrigger>
                )}
                <TabsTrigger value="plans" className="cursor-pointer min-w-0 sm:min-w-[5.5rem] px-2 sm:px-3 touch-manipulation">
                  <Sparkles className="w-4 h-4 flex-shrink-0" />
                  <span className="hidden sm:inline">Plans</span>
                </TabsTrigger>
              </TabsList>

              {showPaidTabs && (
                <TabsContent value="subscription" className="space-y-6 mt-0">
                <Card className="bg-card border-0 shadow-lg">
                  <CardHeader className="p-6 lg:p-8">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <CardTitle className="text-xl">Subscription</CardTitle>
                        {nano && (
                          <Badge variant="secondary" className="gap-1 drop-shadow-[0_0_8px_rgba(252,211,77,0.45)] text-amber-300/95 bg-amber-400/10 border-amber-300/20">
                            <Sparkles className="h-3.5 w-3.5 drop-shadow-[0_0_8px_rgba(252,211,77,0.55)] text-amber-300/95" />
                            Nano
                          </Badge>
                        )}
                        <Badge
                          variant={getStatusVariant(subscription?.status ?? null)}
                          className="capitalize"
                        >
                          {isLoading ? "Loading" : subscription?.status || "Free"}
                        </Badge>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void revalidate()}
                        disabled={isLoading || isFetching}
                        className="cursor-pointer gap-2"
                      >
                        <RefreshCw className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                        <span className="hidden sm:inline">Refresh</span>
                      </Button>
                    </div>
                    <CardDescription>
                      {error
                        ? `Failed to load subscription: ${error.message}`
                        : isLoading
                          ? "Fetching your subscription details…"
                          : subscription
                            ? "Your subscription is managed by Clerk."
                            : "No active subscription found."}
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="pt-0 pb-6 lg:pb-8 px-6 lg:px-8 space-y-6">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">Plan</p>
                        <p className="text-base font-semibold">
                          {nanoItem?.plan?.name ??
                            (isLoading ? "Loading…" : subscription ? "—" : "Free")}
                          {nanoItem?.planPeriod ? ` (${nanoItem.planPeriod})` : ""}
                        </p>
                      </div>
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">Email budget</p>
                          <p className="text-base font-semibold">
                            {nano ? "100 emails/hour + 1000/month" : "10 emails/hour + 10/month"}
                          </p>
                      </div>
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">Active since</p>
                        <p className="text-base font-semibold">{formatDate(subscription?.activeAt)}</p>
                      </div>
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">Next payment</p>
                        <p className="text-base font-semibold">
                          {nextPayment
                            ? `${nextPayment.amount.amountFormatted} on ${formatDate(
                              nextPayment.date
                            )}`
                            : "—"}
                        </p>
                      </div>
                      <div className="space-y-2 sm:col-span-2">
                        <p className="text-sm text-muted-foreground">Payment method</p>
                        <p className="text-base font-semibold">{paymentMethodSummary}</p>
                      </div>
                    </div>

                    <Separator />

                    <div className="flex flex-wrap items-center gap-2">
                      <SubscriptionDetailsButton>
                        <Button variant="default" className="cursor-pointer">
                          Manage subscription
                        </Button>
                      </SubscriptionDetailsButton>
                    </div>
                  </CardContent>
                </Card>
                </TabsContent>
              )}

              {showPaidTabs && (
                <TabsContent value="payment-methods" className="space-y-6 mt-0">
                <Card className="bg-card border-0 shadow-lg">
                  <CardHeader className="p-6 lg:p-8">
                    <CardTitle className="text-xl">Payment Methods</CardTitle>
                    <CardDescription>
                      Manage your saved payment methods for subscriptions and purchases.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0 pb-6 lg:pb-8 px-6 lg:px-8 space-y-4">
                    {isPaymentMethodsLoading ? (
                      <p className="text-sm text-muted-foreground">
                        Loading payment methods…
                      </p>
                    ) : !paymentMethods || paymentMethods.length === 0 ? (
                      <div className="rounded-lg border bg-background/40 backdrop-blur p-8 text-center">
                        <CreditCard className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
                        <p className="text-sm font-medium mb-2">No payment methods</p>
                        <p className="text-sm text-muted-foreground mb-4">
                          Add a payment method to subscribe to a plan.
                        </p>
                        <SubscriptionDetailsButton>
                          <Button variant="default" className="cursor-pointer">
                            Add payment method
                          </Button>
                        </SubscriptionDetailsButton>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {paymentMethods.map((m) => (
                          <div
                            key={m.id}
                            className="flex items-center justify-between rounded-lg border bg-background/40 backdrop-blur px-4 py-3 hover:bg-background/60 transition-colors"
                          >
                            <div className="flex items-center gap-4 flex-1 min-w-0">
                              <div className="flex-shrink-0">
                                <CreditCard className="h-5 w-5 text-muted-foreground" />
                              </div>
                              <div className="flex flex-col min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <p className="text-sm font-medium capitalize truncate">
                                    {m.cardType} •••• {m.last4}
                                  </p>
                                  {m.isDefault && (
                                    <Badge variant="secondary" className="text-xs">Default</Badge>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  Expires{" "}
                                  {String(
                                    ((m as any).expiryMonth ?? (m as any).expirationMonth) ?? ""
                                  ).padStart(2, "0")}
                                  /{(m as any).expiryYear ?? (m as any).expirationYear ?? ""}
                                </p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                  {paymentMethods && paymentMethods.length > 0 && (
                    <CardFooter className="px-6 lg:px-8 pt-0 pb-6 lg:pb-8">
                      <SubscriptionDetailsButton>
                        <Button variant="outline" className="cursor-pointer">
                          Manage payment methods
                        </Button>
                      </SubscriptionDetailsButton>
                    </CardFooter>
                  )}
                </Card>
                </TabsContent>
              )}

              {showPaidTabs && (
                <TabsContent value="history" className="space-y-6 mt-0">
                  <Card className="bg-card border-0 shadow-lg">
                    <CardHeader className="p-6 lg:p-8">
                      <CardTitle className="text-xl">Billing History</CardTitle>
                      <CardDescription>
                        Review your payment history and download receipts.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0 pb-6 lg:pb-8 px-6 lg:px-8">
                      {isPaymentAttemptsLoading ? (
                        <p className="text-sm text-muted-foreground">Loading payments...</p>
                      ) : paymentAttemptsError ? (
                        <p className="text-sm text-destructive">
                          Failed to load payments.
                        </p>
                      ) : paymentAttemptItems.length === 0 ? (
                        <div className="rounded-lg border bg-background/40 backdrop-blur p-8 text-center">
                          <Receipt className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
                          <p className="text-sm font-medium mb-2">No payments yet</p>
                          <p className="text-sm text-muted-foreground">
                            Your payment history will appear here.
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {paymentAttemptItems.map((payment) => {
                            const cardType = payment.paymentMethod?.cardType ?? "Card"
                            const last4 = payment.paymentMethod?.last4
                            const paymentMethodLabel = last4
                              ? `${cardType} **** ${last4}`
                              : "No payment method"
                            const chargeLabel =
                              payment.chargeType === "recurring"
                                ? "Recurring"
                                : payment.chargeType === "checkout"
                                  ? "Checkout"
                                  : "Payment"
                            const timestampLabel = payment.paidAt
                              ? `Paid ${formatDate(payment.paidAt)}`
                              : payment.failedAt
                                ? `Failed ${formatDate(payment.failedAt)}`
                                : `Updated ${formatDate(payment.updatedAt)}`
                            return (
                              <div
                                key={payment.id}
                                className="flex items-center justify-between rounded-lg border bg-background/40 backdrop-blur px-4 py-3 hover:bg-background/60 transition-colors"
                              >
                                <div className="flex items-center gap-4 flex-1 min-w-0">
                                  <div className="flex-shrink-0">
                                    <Receipt className="h-5 w-5 text-muted-foreground" />
                                  </div>
                                  <div className="flex flex-col min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                      <p className="text-sm font-medium">{chargeLabel}</p>
                                      <Badge
                                        variant={getPaymentStatusVariant(payment.status)}
                                        className="capitalize text-xs"
                                      >
                                        {payment.status}
                                      </Badge>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                      {timestampLabel} • {paymentMethodLabel}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-3">
                                  <div className="text-right">
                                    <p className="text-sm font-semibold">
                                      {formatMoney(payment.amount)}
                                    </p>
                                  </div>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleDownloadPaymentPdf(payment)}
                                    className="cursor-pointer"
                                  >
                                    <FileText className="h-4 w-4 mr-2" />
                                    Receipt
                                  </Button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {hasNextPaymentAttempts && (
                        <div className="mt-4 text-center">
                          <Button
                            variant="ghost"
                            onClick={fetchNextPaymentAttempts}
                            className="cursor-pointer"
                            disabled={isPaymentAttemptsFetching}
                          >
                            {isPaymentAttemptsFetching ? "Loading..." : "Load more"}
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>
              )}

              {showPaidTabs && (
                <TabsContent value="organization" className="space-y-6 mt-0">
                  <Card className="bg-card border-0 shadow-lg">
                    <CardHeader className="p-6 lg:p-8">
                      <CardTitle className="text-xl">Organization Billing</CardTitle>
                      <CardDescription>
                        Configure company details for receipts and invoices.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0 pb-6 lg:pb-8 px-6 lg:px-8 space-y-8">
                      {/* Billing Entity Section */}
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <p className="text-sm font-medium">Billing entity</p>
                          <p className="text-xs text-muted-foreground">
                            Choose whether receipts should use your personal details or the organization profile.
                          </p>
                        </div>
                        {hasOrganizations ? (
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-4 rounded-lg border bg-background/40 backdrop-blur">
                            <div className="space-y-1">
                              <p className="text-sm font-medium">
                                {organization?.name ?? "Personal account"}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {organization ? "Receipts use organization details." : "Receipts use personal details."}
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {organization ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void setActive({ organization: null })}
                                  className="cursor-pointer"
                                >
                                  Switch to personal
                                </Button>
                              ) : primaryOrganization ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    void setActive({ organization: primaryOrganization.id })
                                  }
                                  className="cursor-pointer"
                                >
                                  Switch to organization
                                </Button>
                              ) : null}
                              {!hasOrganizations && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    void openCreateOrganization({
                                      skipInvitationScreen: true,
                                      afterCreateOrganizationUrl: "/billing",
                                    })
                                  }
                                  className="cursor-pointer"
                                >
                                  Create organization
                                </Button>
                              )}
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void openOrganizationProfile()}
                                className="cursor-pointer"
                                disabled={!organization}
                              >
                                Manage organization
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <OrganizationSwitcher
                              hidePersonal={false}
                              afterCreateOrganizationUrl="/billing"
                              afterSelectOrganizationUrl="/billing"
                              afterLeaveOrganizationUrl="/billing"
                            />
                            <div className="flex flex-wrap gap-2">
                              <Button
                                variant="outline"
                                onClick={() =>
                                  void openCreateOrganization({
                                    skipInvitationScreen: true,
                                    afterCreateOrganizationUrl: "/billing",
                                  })
                                }
                                className="cursor-pointer"
                              >
                                Create organization
                              </Button>
                              <Button
                                variant="outline"
                                onClick={() => void openOrganizationProfile()}
                                className="cursor-pointer"
                                disabled={!organization}
                              >
                                Manage organization
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>

                      {organization ? (
                        <div className="space-y-8">
                          {/* Organization Selected Notice */}
                          <div className="rounded-lg border bg-primary/5 border-primary/20 p-4">
                            <p className="text-sm font-medium text-primary mb-1">Organization selected</p>
                            <p className="text-xs text-muted-foreground">
                              Receipts will use the saved organization details below.
                            </p>
                          </div>

                          {/* Company Information */}
                          <div className="space-y-4">
                            <h3 className="text-sm font-semibold">Company Information</h3>
                            <div className="grid gap-4 md:grid-cols-2">
                              <div className="space-y-2">
                                <Label htmlFor="org-company-name">Company name</Label>
                                <Input
                                  id="org-company-name"
                                  value={organizationProfile.companyName ?? ""}
                                  onChange={(event) =>
                                    setOrganizationField("companyName", event.target.value)
                                  }
                                  placeholder={organization?.name ?? ""}
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="org-legal-name">Legal name</Label>
                                <Input
                                  id="org-legal-name"
                                  value={organizationProfile.legalName ?? ""}
                                  onChange={(event) =>
                                    setOrganizationField("legalName", event.target.value)
                                  }
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="org-email">Billing email</Label>
                                <Input
                                  id="org-email"
                                  type="email"
                                  value={organizationProfile.email ?? ""}
                                  onChange={(event) =>
                                    setOrganizationField("email", event.target.value)
                                  }
                                  autoComplete="email"
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="org-phone">Phone</Label>
                                <Input
                                  id="org-phone"
                                  type="tel"
                                  value={organizationProfile.phone ?? ""}
                                  onChange={(event) =>
                                    setOrganizationField("phone", event.target.value)
                                  }
                                  autoComplete="tel"
                                />
                              </div>
                            </div>
                          </div>

                          <Separator />

                          {/* Address */}
                          <div className="space-y-4">
                            <h3 className="text-sm font-semibold">Address</h3>
                            <div className="grid gap-4 md:grid-cols-2">
                              <div className="space-y-2 md:col-span-2">
                                <Label htmlFor="org-address-line1">Address line 1</Label>
                                <Input
                                  id="org-address-line1"
                                  value={organizationAddress.line1 ?? ""}
                                  onChange={(event) =>
                                    setOrganizationAddressField("line1", event.target.value)
                                  }
                                  autoComplete="address-line1"
                                />
                              </div>
                              <div className="space-y-2 md:col-span-2">
                                <Label htmlFor="org-address-line2">Address line 2</Label>
                                <Input
                                  id="org-address-line2"
                                  value={organizationAddress.line2 ?? ""}
                                  onChange={(event) =>
                                    setOrganizationAddressField("line2", event.target.value)
                                  }
                                  autoComplete="address-line2"
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="org-city">City</Label>
                                <Input
                                  id="org-city"
                                  value={organizationAddress.city ?? ""}
                                  onChange={(event) =>
                                    setOrganizationAddressField("city", event.target.value)
                                  }
                                  autoComplete="address-level2"
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="org-region">State/Region</Label>
                                <Input
                                  id="org-region"
                                  value={organizationAddress.region ?? ""}
                                  onChange={(event) =>
                                    setOrganizationAddressField("region", event.target.value)
                                  }
                                  autoComplete="address-level1"
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="org-postal">Postal code</Label>
                                <Input
                                  id="org-postal"
                                  value={organizationAddress.postalCode ?? ""}
                                  onChange={(event) =>
                                    setOrganizationAddressField("postalCode", event.target.value)
                                  }
                                  autoComplete="postal-code"
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="org-country">Country</Label>
                                <Input
                                  id="org-country"
                                  value={organizationAddress.country ?? ""}
                                  onChange={(event) =>
                                    setOrganizationAddressField("country", event.target.value)
                                  }
                                  autoComplete="country-name"
                                />
                              </div>
                            </div>
                          </div>

                          <Separator />

                          {/* Tax Information */}
                          <div className="space-y-4">
                            <h3 className="text-sm font-semibold">Tax Information</h3>
                            <div className="space-y-2">
                              <Label htmlFor="org-tax-id">VAT ID</Label>
                              <Input
                                id="org-tax-id"
                                value={organizationProfile.taxId ?? ""}
                                onChange={(event) =>
                                  setOrganizationField("taxId", event.target.value)
                                }
                                onBlur={() => {
                                  const error = validateVatId(organizationProfile.taxId ?? "")
                                  setTaxIdError(error)
                                }}
                                placeholder="DK46156153"
                                className={taxIdError ? "border-destructive" : ""}
                              />
                              {taxIdError ? (
                                <p className="text-sm text-destructive">{taxIdError}</p>
                              ) : (
                                <p className="text-sm text-muted-foreground">
                                  Enter your VAT ID with country code prefix (e.g., DK46156153, GB123456789)
                                </p>
                              )}
                            </div>
                          </div>

                          <Separator />

                          {/* Custom Fields */}
                          <div className="space-y-4">
                            <div className="flex items-center justify-between">
                              <h3 className="text-sm font-semibold">Custom Fields</h3>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  const newKey = `Field ${Object.keys(organizationProfile.customFields ?? {}).length + 1}`
                                  setOrganizationProfile((current) => ({
                                    ...current,
                                    customFields: {
                                      ...(current.customFields ?? {}),
                                      [newKey]: "",
                                    },
                                  }))
                                }}
                                className="cursor-pointer"
                              >
                                <Plus className="h-4 w-4 mr-2" />
                                Add field
                              </Button>
                            </div>
                            {Object.keys(organizationProfile.customFields ?? {}).length > 0 ? (
                              <div className="space-y-3">
                                {Object.entries(organizationProfile.customFields ?? {}).map(([key, value], index) => (
                                  <div key={index} className="grid gap-3 md:grid-cols-[1fr_2fr_auto] items-end">
                                    <Input
                                      placeholder="Field name"
                                      value={key}
                                      onChange={(e) => {
                                        const newKey = e.target.value
                                        const oldValue = organizationProfile.customFields?.[key] ?? ""
                                        setOrganizationProfile((current) => {
                                          const fields = { ...(current.customFields ?? {}) }
                                          delete fields[key]
                                          if (newKey.trim()) {
                                            fields[newKey] = oldValue
                                          }
                                          return { ...current, customFields: fields }
                                        })
                                      }}
                                    />
                                    <Input
                                      placeholder="Value"
                                      value={value}
                                      onChange={(e) => {
                                        setOrganizationProfile((current) => ({
                                          ...current,
                                          customFields: {
                                            ...(current.customFields ?? {}),
                                            [key]: e.target.value,
                                          },
                                        }))
                                      }}
                                    />
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => {
                                        setOrganizationProfile((current) => {
                                          const fields = { ...(current.customFields ?? {}) }
                                          delete fields[key]
                                          return { ...current, customFields: fields }
                                        })
                                      }}
                                      className="cursor-pointer"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-sm text-muted-foreground">
                                Add custom fields like internal reference, ID, or any other information you need on receipts.
                              </p>
                            )}
                          </div>

                          <Separator />

                          {/* Save Actions */}
                          <div className="space-y-3">
                            <div className="flex flex-wrap items-center gap-3">
                              <Button
                                variant="default"
                                onClick={() => void handleSaveOrganizationProfile()}
                                className="cursor-pointer"
                                disabled={isSavingOrganization}
                              >
                                {isSavingOrganization ? "Saving..." : "Save organization"}
                              </Button>
                              <Button
                                variant="ghost"
                                onClick={handleResetOrganizationProfile}
                                className="cursor-pointer"
                              >
                                Reset
                              </Button>
                            </div>
                            {organizationSaveError && (
                              <p className="text-sm text-destructive">{organizationSaveError}</p>
                            )}
                            {organizationSaveSuccess && (
                              <p className="text-sm text-muted-foreground flex items-center gap-2">
                                <CheckCircle2 className="h-4 w-4" />
                                {organizationSaveSuccess}
                              </p>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-lg border bg-background/40 backdrop-blur p-8 text-center">
                          <Building2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
                          <p className="text-sm font-medium mb-2">No organization selected</p>
                          <p className="text-sm text-muted-foreground mb-4">
                            Select or create an organization to add company details to receipts.
                          </p>
                          <div className="flex flex-wrap justify-center gap-2">
                            {!hasOrganizations && (
                              <Button
                                variant="default"
                                onClick={() =>
                                  void openCreateOrganization({
                                    skipInvitationScreen: true,
                                    afterCreateOrganizationUrl: "/billing",
                                  })
                                }
                                className="cursor-pointer"
                              >
                                Create organization
                              </Button>
                            )}
                            {hasOrganizations && primaryOrganization && (
                              <Button
                                variant="default"
                                onClick={() =>
                                  void setActive({ organization: primaryOrganization.id })
                                }
                                className="cursor-pointer"
                              >
                                Switch to organization
                              </Button>
                            )}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>
              )}

              <TabsContent value="plans" className="space-y-6 mt-0">
                <Card className="bg-card border-0 shadow-lg">
                  <CardHeader className="p-6 lg:p-8">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <CardTitle className="text-xl">Plans & Pricing</CardTitle>
                        <CardDescription className="mt-2">
                          Choose the plan that's right for you. All plans include core monitoring features.
                        </CardDescription>
                      </div>
                      {nano && (
                        <Badge variant="secondary" className="gap-1 drop-shadow-[0_0_8px_rgba(252,211,77,0.45)] text-amber-300/95 bg-amber-400/10 border-amber-300/20 self-start sm:self-auto">
                          <Sparkles className="h-3.5 w-3.5 drop-shadow-[0_0_8px_rgba(252,211,77,0.55)] text-amber-300/95" />
                          Current: Nano
                        </Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0 pb-6 lg:pb-8 px-2 sm:px-6 lg:px-8">
                    {!nano && (
                      <div className="mb-6 rounded-lg border border-primary/20 bg-primary/5 backdrop-blur p-6">
                        <div className="flex items-start gap-4">
                          <div className="flex-shrink-0 rounded-full bg-primary/10 p-2">
                            <Sparkles className="h-5 w-5 text-primary" />
                          </div>
                          <div className="space-y-2 flex-1">
                            <h4 className="font-semibold text-base">Recommended: Nano Plan</h4>
                            <p className="text-sm text-muted-foreground">
                              Unlock advanced features with the Nano plan:
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
                              <div className="flex items-start gap-2">
                                <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                                <div>
                                  <p className="text-sm font-medium">SMS Alerts</p>
                                  <p className="text-xs text-muted-foreground">Get critical downtime alerts sent directly to your phone</p>
                                </div>
                              </div>
                              <div className="flex items-start gap-2">
                                <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                                <div>
                                  <p className="text-sm font-medium">Status Page Branding</p>
                                  <p className="text-xs text-muted-foreground">Custom logo, favicon, and brand colors</p>
                                </div>
                              </div>
                              <div className="flex items-start gap-2">
                                <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                                <div>
                                  <p className="text-sm font-medium">Custom Status Page Domain</p>
                                  <p className="text-xs text-muted-foreground">Use your own domain for public status pages</p>
                                </div>
                              </div>
                              <div className="flex items-start gap-2">
                                <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                                <div>
                                  <p className="text-sm font-medium">Higher Email Limits</p>
                                  <p className="text-xs text-muted-foreground">100 emails/hour + 1000/month vs 10/hour + 10/month</p>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    <div className="rounded-xl border bg-background/40 backdrop-blur p-3 sm:p-6">
                      <PricingTable />
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </SignedIn>
        </div>
      </div>
    </PageContainer>
  )
}
