import type { OrganizationBillingAddress } from "@/api/types"
import receiptConfig from "@/config/receipt.json"

// ---- Public types ----

export type BillingRecipient = {
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

export type PaymentReceiptData = {
  id: string
  status?: string | null
  paidAt?: Date | null
  updatedAt?: Date | null
  amount?: { amountFormatted: string; currency?: string | null } | null
  chargeType?: string | null
  paymentMethod?: { cardType?: string | null; last4?: string | null } | null
  subscriptionItem?: {
    plan?: { name?: string | null; slug?: string | null } | null
    planPeriod?: string | null
  } | null
}

// ---- Address helpers (re-used by Billing page for recipient computation) ----

export function buildOrganizationAddressLines(
  address: OrganizationBillingAddress | null | undefined,
) {
  if (!address) return []
  const cityRegion = [address.city, address.region].filter(Boolean).join(", ")
  const postalCountry = [address.postalCode, address.country].filter(Boolean).join(" ")
  return [address.line1, address.line2, cityRegion, postalCountry].filter(
    (l): l is string => Boolean(l && l.trim().length > 0),
  )
}

// ---- Receipt config ----

type ReceiptConfig = {
  seller?: {
    displayName?: string
    legalName?: string
    email?: string
    website?: string
    phone?: string
    address?: { line1?: string; line2?: string; city?: string; region?: string; postalCode?: string; country?: string }
  }
  tax?: { taxId?: string; taxIdLabel?: string }
  receipt?: { statement?: string; footerNote?: string; disclaimer?: string }
  style?: { accentColor?: string; logoText?: string; receiptTitle?: string }
}

const CFG = receiptConfig as ReceiptConfig
const SELLER = CFG.seller ?? {}
const SA = SELLER.address ?? {}

const ISSUER = {
  name: SELLER.displayName || SELLER.legalName || "Exit1.dev",
  legalName: SELLER.legalName || SELLER.displayName || "Exit1.dev",
  email: SELLER.email || "support@exit1.dev",
  website: SELLER.website || "https://exit1.dev",
  phone: SELLER.phone,
  addressLines: [
    SA.line1,
    SA.line2,
    [SA.city, SA.region].filter(Boolean).join(", "),
    [SA.postalCode, SA.country].filter(Boolean).join(" "),
  ].filter((l) => l && l.trim().length > 0),
  taxId: CFG.tax?.taxId,
}

const STYLE = CFG.style ?? {}
const BRAND = STYLE.logoText || ISSUER.name
const TITLE = STYLE.receiptTitle || "Payment receipt"
const ACCENT_HEX = STYLE.accentColor || "#2563eb"
const STATEMENT = CFG.receipt?.statement || "Digital service subscription receipt."
const FOOTER = CFG.receipt?.footerNote || "Thank you for your business."
const DISCLAIMER = CFG.receipt?.disclaimer

// ---- PDF primitives ----

function fmtDate(d: Date | null | undefined) {
  return d ? d.toISOString().slice(0, 10) : "N/A"
}

function fmtMoney(a: { amountFormatted: string; currency?: string | null } | null | undefined) {
  if (!a) return "N/A"
  return `${a.currency ?? "USD"} ${a.amountFormatted}`
}

function sanitize(v: string) {
  return Array.from(v)
    .map((c) => {
      const code = c.codePointAt(0) ?? 0
      if (code < 32 || code === 127) return " "
      if (code <= 255) return c
      return "?"
    })
    .join("")
}

function encodeLiteral(v: string) {
  const s = sanitize(v)
  const bytes: number[] = []
  for (const c of s) bytes.push(c.codePointAt(0) ?? 63)
  return bytes
    .map((b) => {
      if (b === 0x28) return "\\("
      if (b === 0x29) return "\\)"
      if (b === 0x5c) return "\\\\"
      if (b >= 0x20 && b <= 0x7e) return String.fromCharCode(b)
      return `\\${b.toString(8).padStart(3, "0")}`
    })
    .join("")
}

function wrap(v: string, max: number) {
  const s = sanitize(v).trim()
  if (s.length <= max) return [s]
  const words = s.split(" ")
  const lines: string[] = []
  let cur = ""
  for (const w of words) {
    if (!cur) { cur = w; continue }
    if ((cur + " " + w).length > max) { lines.push(cur); cur = w }
    else cur = `${cur} ${w}`
  }
  if (cur) lines.push(cur)
  return lines
}

function hexToRgb(hex: string) {
  const c = hex.trim().replace(/^#/, "")
  if (c.length !== 3 && c.length !== 6) return null
  const f = c.length === 3 ? c.split("").map((x) => x + x).join("") : c
  const n = Number.parseInt(f, 16)
  if (Number.isNaN(n)) return null
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

function colorFromHex(hex: string, fallback: string) {
  const rgb = hexToRgb(hex)
  return rgb ? `${rgb.r.toFixed(3)} ${rgb.g.toFixed(3)} ${rgb.b.toFixed(3)}` : fallback
}

const C = {
  accent: colorFromHex(ACCENT_HEX, "0.145 0.388 0.922"),
  text: "0 0 0",
  muted: "0.35 0.35 0.35",
  line: "0.86 0.86 0.86",
  fill: "0.96 0.96 0.96",
}

type Opts = { size?: number; font?: "F1" | "F2"; color?: string; align?: "left" | "right" }

function txt(t: string, x: number, y: number, o?: Opts) {
  const sz = o?.size ?? 11
  const fn = o?.font ?? "F1"
  const cl = o?.color ?? C.text
  const w = t.length * sz * 0.52
  const fx = o?.align === "right" ? x - w : x
  return `BT /${fn} ${sz} Tf ${cl} rg 1 0 0 1 ${fx.toFixed(2)} ${y.toFixed(2)} Tm (${encodeLiteral(t)}) Tj ET`
}

function line(x1: number, y1: number, x2: number, y2: number, color: string, w: number) {
  return `${color} RG ${w} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`
}

function rect(x: number, y: number, w: number, h: number, color: string) {
  return `${color} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`
}

function pushWrapped(cmds: string[], text: string, x: number, y: number, max: number, o?: Opts) {
  const sz = o?.size ?? 11
  const lh = sz + 3
  let cur = y
  for (const ln of wrap(text, max)) { cmds.push(txt(ln, x, cur, o)); cur -= lh }
  return cur
}

function statusLabel(s: string | null | undefined) {
  if (!s) return "N/A"
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function recipientLines(r: BillingRecipient) {
  if (!r.isOrganization) return [`Name: ${r.name}`, `Email: ${r.email}`]
  const out: string[] = [`Company: ${r.name}`]
  if (r.legalName && r.legalName !== r.name) out.push(`Legal name: ${r.legalName}`)
  if (r.addressLines?.length) out.push(...r.addressLines)
  if (r.email) out.push(`Email: ${r.email}`)
  if (r.phone) out.push(`Phone: ${r.phone}`)
  if (r.taxId) out.push(`VAT ID: ${r.taxId}`)
  if (r.customFields) {
    Object.entries(r.customFields).forEach(([k, v]) => { if (v?.trim()) out.push(`${k}: ${v}`) })
  }
  return out
}

function buildPdf(cmds: string[]) {
  const stream = cmds.join("\n")
  const objs = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n",
    "6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n",
  ]
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  for (const o of objs) { offsets.push(pdf.length); pdf += o }
  const xref = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
  const xs = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${xref}`
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xs}\n%%EOF`
  return new Blob([new TextEncoder().encode(pdf)], { type: "application/pdf" })
}

// ---- Public API ----

export function downloadPaymentReceipt(payment: PaymentReceiptData, recipient: BillingRecipient) {
  const cmds: string[] = []
  const pw = 612, ph = 792, m = 54
  const re = pw - m, rcx = 330

  const method = payment.paymentMethod?.last4
    ? `${payment.paymentMethod.cardType} **** ${payment.paymentMethod.last4}`
    : "No payment method"
  const plan =
    payment.subscriptionItem?.plan?.name ??
    payment.subscriptionItem?.plan?.slug ??
    "Exit1.dev subscription"
  const period =
    payment.subscriptionItem?.planPeriod === "annual" ? "Annual"
      : payment.subscriptionItem?.planPeriod === "month" ? "Monthly"
      : "One-time"
  const charge =
    payment.chargeType === "recurring" ? "Subscription payment"
      : payment.chargeType === "checkout" ? "Checkout payment"
      : "Payment"

  let y = ph - m

  cmds.push(txt(BRAND, m, y, { size: 20, font: "F2" }))
  cmds.push(txt(TITLE, re, y, { size: 18, font: "F2", align: "right" }))
  y -= 20
  const ss = y
  y = pushWrapped(cmds, STATEMENT, m, y, 70, { size: 10, color: C.muted })
  cmds.push(txt(`Status: ${statusLabel(payment.status)}`, re, ss, { size: 10, color: C.accent, align: "right" }))
  y -= 4
  cmds.push(line(m, y, re, y, C.line, 1))
  y -= 18

  // Seller
  const sy = y
  cmds.push(txt("Seller", m, y, { size: 11, font: "F2", color: C.accent }))
  let ly = y - 14
  for (const l of [ISSUER.legalName, ...ISSUER.addressLines, ISSUER.email, ISSUER.phone, ISSUER.taxId ? `VAT ID: ${ISSUER.taxId}` : ""].filter(Boolean) as string[]) {
    ly = pushWrapped(cmds, l, m, ly, 42, { size: 10 })
  }

  // Receipt details
  let ry = sy
  cmds.push(txt("Receipt details", rcx, ry, { size: 11, font: "F2", color: C.accent }))
  ry -= 14
  for (const l of [`Receipt ID: ${payment.id}`, `Date: ${fmtDate(payment.paidAt ?? payment.updatedAt)}`, `Amount: ${fmtMoney(payment.amount)}`, `Charge: ${charge}`, `Method: ${method}`]) {
    ry = pushWrapped(cmds, l, rcx, ry, 36, { size: 10 })
  }

  y = Math.min(ly, ry) - 12

  // Billed to
  cmds.push(txt("Billed to", m, y, { size: 11, font: "F2", color: C.accent }))
  y -= 14
  for (const l of recipientLines(recipient)) y = pushWrapped(cmds, l, m, y, 50, { size: 10 })
  y -= 10

  // Line item
  cmds.push(txt("Item", m, y, { size: 11, font: "F2" }))
  cmds.push(txt("Amount", re, y, { size: 11, font: "F2", align: "right" }))
  y -= 8
  cmds.push(line(m, y, re, y, C.line, 1))
  y -= 14

  const desc = `${plan} (${period})`
  const dl = wrap(desc, 60)
  const isy = y
  dl.forEach((l, i) => cmds.push(txt(l, m, isy - i * 14, { size: 11 })))
  cmds.push(txt(fmtMoney(payment.amount), re, isy, { size: 12, font: "F2", align: "right" }))
  y = isy - dl.length * 14 - 4
  cmds.push(txt(charge, m, y, { size: 10, color: C.muted }))
  y -= 16
  cmds.push(txt(`Payment method: ${method}`, m, y, { size: 10, color: C.muted }))
  y -= 18

  // Total box
  const bw = 200, bh = 48, bx = re - bw, by = y - bh
  cmds.push(rect(bx, by, bw, bh, C.fill))
  cmds.push(line(bx, by + bh, bx + bw, by + bh, C.line, 1))
  cmds.push(txt("Total paid", bx + 12, by + bh - 16, { size: 10, color: C.muted }))
  cmds.push(txt(fmtMoney(payment.amount), bx + bw - 12, by + 16, { size: 14, font: "F2", align: "right" }))

  // Footer
  let fy = Math.max(60, by - 24)
  if (DISCLAIMER) fy = pushWrapped(cmds, DISCLAIMER, m, fy, 80, { size: 9, color: C.muted }) - 8
  cmds.push(txt(FOOTER, m, fy, { size: 9, color: C.muted }))

  // Build & download
  const name = sanitize(`exit1-payment-${payment.id}.pdf`.replace(/[^a-zA-Z0-9-_.]/g, "_"))
  const blob = buildPdf(cmds)
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
