import { useEffect, useMemo, useState, type ComponentProps } from "react"
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
  useSubscription,
} from "@clerk/clerk-react/experimental"
import { CreditCard, RefreshCw, Sparkles } from "lucide-react"

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
import { PageContainer, PageHeader } from "@/components/layout"
import { apiClient } from "@/api/client"
import type { OrganizationBillingAddress, OrganizationBillingProfile } from "@/api/types"
import { getNanoSubscriptionItem, isNanoPlan } from "@/lib/subscription"
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

type BillingRecipient = {
  name: string
  email: string
  legalName?: string
  phone?: string
  addressLines?: string[]
  taxId?: string
  taxIdLabel?: string
  isOrganization?: boolean
}

function createEmptyOrganizationProfile(): OrganizationBillingProfile {
  return {
    companyName: "",
    legalName: "",
    email: "",
    phone: "",
    taxId: "",
    taxIdLabel: "",
    address: {
      line1: "",
      line2: "",
      city: "",
      region: "",
      postalCode: "",
      country: "",
    },
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

  const normalizedProfile: OrganizationBillingProfile = {
    companyName: normalizeProfileValue(profile.companyName),
    legalName: normalizeProfileValue(profile.legalName),
    email: normalizeProfileValue(profile.email),
    phone: normalizeProfileValue(profile.phone),
    taxId: normalizeProfileValue(profile.taxId),
    taxIdLabel: normalizeProfileValue(profile.taxIdLabel),
    ...(hasAddress ? { address: normalizedAddress } : {}),
  }

  const hasProfile = Boolean(
    normalizedProfile.companyName ||
      normalizedProfile.legalName ||
      normalizedProfile.email ||
      normalizedProfile.phone ||
      normalizedProfile.taxId ||
      normalizedProfile.taxIdLabel ||
      normalizedProfile.address
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

  const profile: OrganizationBillingProfile = {
    companyName: readValue(record.companyName),
    legalName: readValue(record.legalName),
    email: readValue(record.email),
    phone: readValue(record.phone),
    taxId: readValue(record.taxId),
    taxIdLabel: readValue(record.taxIdLabel),
    ...(address ? { address } : {}),
  }

  const hasProfile = Boolean(
    profile.companyName ||
      profile.legalName ||
      profile.email ||
      profile.phone ||
      profile.taxId ||
      profile.taxIdLabel ||
      profile.address
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
    lines.push(`${recipient.taxIdLabel || "Tax ID"}: ${recipient.taxId}`)
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
  taxIdLabel: RECEIPT_CONFIG.tax?.taxIdLabel || "Tax ID",
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
  const { data: subscription, isLoading, isFetching, error, revalidate } =
    useSubscription()
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
  const [organizationProfile, setOrganizationProfile] = useState<OrganizationBillingProfile>(
    () => createEmptyOrganizationProfile()
  )
  const [savedOrganizationProfile, setSavedOrganizationProfile] =
    useState<OrganizationBillingProfile | null>(null)
  const [isSavingOrganization, setIsSavingOrganization] = useState(false)
  const [organizationSaveError, setOrganizationSaveError] = useState<string | null>(null)
  const [organizationSaveSuccess, setOrganizationSaveSuccess] = useState<string | null>(null)

  useEffect(() => {
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

  const nanoItem = useMemo(
    () => getNanoSubscriptionItem(subscription ?? null),
    [subscription]
  )
  const nano = useMemo(() => isNanoPlan(subscription ?? null), [subscription])
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
    const taxIdLabel = profile?.taxIdLabel || "Tax ID"

    return {
      isOrganization: true,
      name: companyName,
      legalName,
      email,
      phone,
      addressLines,
      taxId,
      taxIdLabel,
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
      PDF_ISSUER.taxId ? `${PDF_ISSUER.taxIdLabel}: ${PDF_ISSUER.taxId}` : "",
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
        }
      />

      <div className="flex-1 overflow-auto -mx-4 sm:-mx-6 lg:-mx-12 px-4 sm:px-6 lg:px-12">
        <div className="mx-auto grid max-w-5xl gap-6 lg:gap-8 w-full">
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
            {nano && (
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <Card className="bg-card border-0 shadow-lg">
                  <CardHeader className="p-6 lg:p-8 gap-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-xl">Current plan</CardTitle>
                        {nano && (
                          <Badge variant="secondary" className="gap-1">
                            <Sparkles className="h-3.5 w-3.5" />
                            Nano
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {nanoItem?.plan?.name && (
                          <Badge variant="outline" className="hidden sm:inline-flex">
                            {nanoItem.plan.name}
                          </Badge>
                        )}
                        <Badge
                          variant={getStatusVariant(subscription?.status ?? null)}
                          className="capitalize"
                        >
                          {isLoading ? "Loading" : subscription?.status || "Free"}
                        </Badge>
                      </div>
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

                  <CardContent className="pt-0 pb-6 lg:pb-8 px-6 lg:px-8 space-y-4">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div className="space-y-1">
                        <p className="text-muted-foreground">Plan</p>
                        <p className="font-medium">
                          {nanoItem?.plan?.name ??
                            (isLoading ? "Loading…" : subscription ? "—" : "Free")}
                          {nanoItem?.planPeriod ? ` (${nanoItem.planPeriod})` : ""}
                        </p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">Email budget</p>
                        <p className="font-medium">
                          {nano ? "100 emails/hour" : "10 emails/hour"}
                        </p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">Active since</p>
                        <p className="font-medium">{formatDate(subscription?.activeAt)}</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">Next payment</p>
                        <p className="font-medium">
                          {nextPayment
                            ? `${nextPayment.amount.amountFormatted} on ${formatDate(
                              nextPayment.date
                            )}`
                            : "—"}
                        </p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">Payment method</p>
                        <p className="font-medium">{paymentMethodSummary}</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">Sync</p>
                        <p className="font-medium">{isFetching ? "Refreshing…" : "Up to date"}</p>
                      </div>
                    </div>

                    <Separator />

                    <div className="flex flex-wrap items-center gap-2">
                      <SubscriptionDetailsButton>
                        <Button variant="default" className="cursor-pointer">
                          Manage subscription
                        </Button>
                      </SubscriptionDetailsButton>
                      <Button
                        variant="outline"
                        onClick={() => void revalidate()}
                        disabled={isLoading}
                        className="cursor-pointer"
                      >
                        Refresh
                      </Button>
                    </div>

                    <p className="text-xs text-muted-foreground">
                      Receipts are available for each payment below.
                    </p>
                  </CardContent>
                </Card>

                <Card className="bg-card border-0 shadow-lg">
                  <CardHeader className="p-6 lg:p-8">
                    <CardTitle className="text-xl">Payment methods</CardTitle>
                    <CardDescription>
                      Saved cards on your account (via Clerk).
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0 pb-6 lg:pb-8 px-6 lg:px-8 space-y-3">
                    {isPaymentMethodsLoading ? (
                      <p className="text-sm text-muted-foreground">
                        Loading payment methods…
                      </p>
                    ) : !paymentMethods || paymentMethods.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No payment methods found.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {paymentMethods.map((m) => (
                          <div
                            key={m.id}
                            className="flex items-center justify-between rounded-lg border bg-background/40 backdrop-blur px-3 py-2"
                          >
                            <div className="flex flex-col min-w-0">
                              <p className="text-sm font-medium capitalize truncate">
                                {m.cardType} •••• {m.last4}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Expires{" "}
                                {String(
                                  ((m as any).expiryMonth ?? (m as any).expirationMonth) ?? ""
                                ).padStart(2, "0")}
                                /{(m as any).expiryYear ?? (m as any).expirationYear ?? ""}
                              </p>
                            </div>
                            {m.isDefault && <Badge variant="secondary">Default</Badge>}
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                  <CardFooter className="px-6 lg:px-8 pt-0 pb-6 lg:pb-8">
                    <SubscriptionDetailsButton>
                      <Button variant="outline" className="cursor-pointer">
                        Manage payment methods
                      </Button>
                    </SubscriptionDetailsButton>
                  </CardFooter>
                </Card>
              </div>
            )}

            {nano ? (
              <Card className="bg-card border-0 shadow-lg">
                <CardHeader className="p-6 lg:p-8">
                  <CardTitle className="text-xl">Organization billing</CardTitle>
                  <CardDescription>
                    Add company details to receipts by selecting or creating an organization.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0 pb-6 lg:pb-8 px-6 lg:px-8 space-y-6">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="space-y-2">
                      <p className="text-sm font-medium">Billing entity</p>
                      <p className="text-xs text-muted-foreground">
                        Choose whether receipts should use your personal details or the organization
                        profile.
                      </p>
                      {hasOrganizations ? (
                        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-background/40 px-3 py-2 text-sm">
                          <span className="font-medium">
                            {organization?.name ?? "Personal account"}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {organization ? "Receipts use organization details." : "Receipts use personal details."}
                          </span>
                          {organization ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void setActive({ organization: null })}
                              className="cursor-pointer"
                            >
                              Switch to personal
                            </Button>
                          ) : primaryOrganization ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                void setActive({ organization: primaryOrganization.id })
                              }
                              className="cursor-pointer"
                            >
                              Switch to organization
                            </Button>
                          ) : null}
                        </div>
                      ) : (
                        <OrganizationSwitcher
                          hidePersonal={false}
                          afterCreateOrganizationUrl="/billing"
                          afterSelectOrganizationUrl="/billing"
                          afterLeaveOrganizationUrl="/billing"
                        />
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {!hasOrganizations && (
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
                      )}
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

                  {organization ? (
                    <div className="space-y-6">
                      <p className="text-sm text-muted-foreground">
                        Receipts will use the saved organization details below.
                      </p>

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

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="org-tax-label">Tax ID label</Label>
                          <Input
                            id="org-tax-label"
                            value={organizationProfile.taxIdLabel ?? ""}
                            onChange={(event) =>
                              setOrganizationField("taxIdLabel", event.target.value)
                            }
                            placeholder="VAT ID"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="org-tax-id">Tax ID</Label>
                          <Input
                            id="org-tax-id"
                            value={organizationProfile.taxId ?? ""}
                            onChange={(event) =>
                              setOrganizationField("taxId", event.target.value)
                            }
                          />
                        </div>
                      </div>

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
                        {organizationSaveError ? (
                          <p className="text-sm text-destructive">{organizationSaveError}</p>
                        ) : organizationSaveSuccess ? (
                          <p className="text-sm text-muted-foreground">
                            {organizationSaveSuccess}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-lg border bg-background/40 p-4 text-sm text-muted-foreground">
                      Select or create an organization to add company details to receipts.
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card className="bg-card border-0 shadow-lg">
                <CardHeader className="p-6 lg:p-8">
                  <CardTitle className="text-xl">Organization billing</CardTitle>
                  <CardDescription>
                    Organization billing is available on the Nano plan.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0 pb-6 lg:pb-8 px-6 lg:px-8">
                  <div className="rounded-lg border bg-background/40 p-4 text-sm text-muted-foreground">
                    Upgrade to Nano to create organizations and add company details to receipts.
                  </div>
                </CardContent>
              </Card>
            )}

            {nano && (
              <Card className="bg-card border-0 shadow-lg">
                <CardHeader className="p-6 lg:p-8">
                  <CardTitle className="text-xl">Payments</CardTitle>
                  <CardDescription>
                    Review payment history and download receipts.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0 pb-6 lg:pb-8 px-6 lg:px-8">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">Payments</p>
                      {isPaymentAttemptsFetching && (
                        <p className="text-xs text-muted-foreground">Refreshing...</p>
                      )}
                    </div>
                    {isPaymentAttemptsLoading ? (
                      <p className="text-sm text-muted-foreground">Loading payments...</p>
                    ) : paymentAttemptsError ? (
                      <p className="text-sm text-muted-foreground">
                        Failed to load payments.
                      </p>
                    ) : paymentAttemptItems.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No payments yet.</p>
                    ) : (
                      <div className="space-y-2">
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
                              className="flex items-center justify-between rounded-lg border bg-background/40 backdrop-blur px-3 py-2"
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="text-sm font-medium">Payment</p>
                                  <Badge
                                    variant={getPaymentStatusVariant(payment.status)}
                                    className="capitalize"
                                  >
                                    {payment.status}
                                  </Badge>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  {timestampLabel}
                                </p>
                              </div>
                              <div className="flex flex-col items-end gap-2">
                                <div className="text-right">
                                  <p className="text-sm font-semibold">
                                    {formatMoney(payment.amount)}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {chargeLabel} - {paymentMethodLabel}
                                  </p>
                                </div>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleDownloadPaymentPdf(payment)}
                                  className="cursor-pointer"
                                >
                                  Receipt PDF
                                </Button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {hasNextPaymentAttempts && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={fetchNextPaymentAttempts}
                        className="cursor-pointer"
                      >
                        Load more payments
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="bg-card border-0 shadow-lg">
              <CardHeader className="p-6 lg:p-8">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-xl">Plans</CardTitle>
                  {nano && (
                    <Badge variant="secondary" className="gap-1">
                      <Sparkles className="h-3.5 w-3.5" />
                      Nano
                    </Badge>
                  )}
                </div>
                <CardDescription>
                  Upgrade, downgrade, or start a subscription.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0 pb-6 lg:pb-8 px-2 sm:px-6 lg:px-8">
                {!nano && (
                  <div className="mb-6 rounded-lg border border-primary/20 bg-primary/5 p-4">
                    <div className="flex items-start gap-3">
                      <Sparkles className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                      <div className="space-y-1">
                        <h4 className="font-medium text-sm">Recommended: Nano Plan</h4>
                        <p className="text-sm text-muted-foreground">
                          Upgrade to Nano for advanced features:
                        </p>
                        <ul className="text-sm text-muted-foreground list-disc list-inside mt-2 space-y-1">
                          <li><span className="font-medium text-foreground">Advanced Organization:</span> Drag & drop checks, nested folders, and full folder management.</li>
                          <li><span className="font-medium text-foreground">Higher Limits:</span> 100 emails/hour notification budget.</li>
                          <li><span className="font-medium text-foreground">Map view:</span> Get the full visual view of where your services are and where we ping them from.</li>
                          <li><span className="font-medium text-foreground">Timeline view:</span> Get the full overview of each day for all checks.</li>
                          <li><span className="font-medium text-foreground">SMS Alerts:</span> Get the most important alerts directly in your pocket.</li>
                          <li><span className="font-medium text-foreground">Comments (Upcoming):</span> Comment on incidents to keep documentation.</li>
                          <li><span className="font-medium text-foreground">Incident reports (Upcoming):</span> Get weekly or monthly automated reports sent to your inbox.</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                )}
                <div className="rounded-xl border bg-background/40 backdrop-blur p-3 sm:p-6">
                  <PricingTable />
                </div>
              </CardContent>
            </Card>
          </SignedIn>
        </div>
      </div>
    </PageContainer>
  )
}
