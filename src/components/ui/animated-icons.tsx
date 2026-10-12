import * as React from "react"
import { m, useReducedMotion, type Variants } from "motion/react"

/**
 * Sidebar icons that move when their nav row is hovered, after the ones in
 * Day3. Each is lucide's own drawing (same paths as the static icon it
 * replaces) with one small motion that says what the page is for: the chart
 * bars grow, the status trace redraws, the radio waves broadcast.
 *
 * The parent row owns the hover and passes `motion`, so the whole row is the
 * target, not just the 16px glyph. Variant labels propagate from the <m.svg>
 * to every child that has variants, which is why the children only declare
 * their own variants and never `animate`.
 *
 * Needs a <LazyMotion> ancestor (AppSidebar has one). Until its features load
 * the icons render as plain static SVGs, which is also what they fall back to
 * under prefers-reduced-motion.
 */

export type IconMotion = "normal" | "animate"

export interface AnimatedIconProps {
  className?: string
  motion?: IconMotion
}

export type AnimatedIcon = React.FC<AnimatedIconProps> & { animated: true }

export function isAnimatedIcon(icon: unknown): icon is AnimatedIcon {
  return typeof icon === "function" && (icon as Partial<AnimatedIcon>).animated === true
}

/** Hover and keyboard-focus handlers for the row that hosts an animated icon. */
export function useIconMotion() {
  const [motion, setMotion] = React.useState<IconMotion>("normal")
  const handlers = React.useMemo(
    () => ({
      onMouseEnter: () => setMotion("animate"),
      onMouseLeave: () => setMotion("normal"),
      onFocus: (e: React.FocusEvent<HTMLElement>) => {
        if (e.currentTarget.matches(":focus-visible")) setMotion("animate")
      },
      onBlur: () => setMotion("normal"),
    }),
    [],
  )
  return [motion, handlers] as const
}

// Shared timing: one 0.7s gesture in, a quick 0.2s settle out. Long enough to
// read, short enough that sweeping the cursor down the list never queues up.
const IN = { duration: 0.7, ease: "easeInOut" } as const
const OUT = { duration: 0.2, ease: "easeOut" } as const

// A line that redraws itself from its start point.
const DRAW: Variants = {
  normal: { pathLength: 1, opacity: 1, transition: OUT },
  animate: (i: number = 0) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      pathLength: { ...IN, duration: 0.5, delay: i * 0.1 },
      opacity: { duration: 0.15, delay: i * 0.1 },
    },
  }),
}

function Svg({
  motion = "normal",
  className,
  variants,
  style,
  viewBox = "0 0 24 24",
  children,
}: AnimatedIconProps & {
  variants?: Variants
  viewBox?: string
  style?: React.ComponentProps<typeof m.svg>["style"]
  children: React.ReactNode
}) {
  const reduce = useReducedMotion()
  return (
    <m.svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      initial="normal"
      animate={reduce ? "normal" : motion}
      variants={variants}
      style={style}
    >
      {children}
    </m.svg>
  )
}

function define(name: string, render: React.FC<AnimatedIconProps>): AnimatedIcon {
  render.displayName = name
  return Object.assign(render, { animated: true as const })
}

// Checks: the globe turns once, its meridian sweeping across the face.
const MERIDIAN: Variants = {
  normal: { scaleX: 1, transition: OUT },
  animate: { scaleX: [1, 0.2, -1, 0.2, 1], transition: { ...IN, duration: 0.8 } },
}
export const GlobeIcon = define("GlobeIcon", (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <m.path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" variants={MERIDIAN} />
    <path d="M2 12h20" />
  </Svg>
))

// Live: the waves fade out and back from the centre, inner pair first.
const WAVE: Variants = {
  normal: { opacity: 1, transition: OUT },
  animate: (i: number) => ({
    opacity: [1, 0.15, 1],
    transition: { ...IN, duration: 0.6, delay: i * 0.15 },
  }),
}
export const RadioIcon = define("RadioIcon", (p) => (
  <Svg {...p}>
    <m.path d="M16.247 7.761a6 6 0 0 1 0 8.478" custom={0} variants={WAVE} />
    <m.path d="M19.075 4.933a10 10 0 0 1 0 14.134" custom={1} variants={WAVE} />
    <m.path d="M4.925 19.067a10 10 0 0 1 0-14.134" custom={1} variants={WAVE} />
    <m.path d="M7.753 16.239a6 6 0 0 1 0-8.478" custom={0} variants={WAVE} />
    <circle cx="12" cy="12" r="2" />
  </Svg>
))

// Reports: each bar grows up from the axis, left to right.
export const ChartColumnIcon = define("ChartColumnIcon", (p) => (
  <Svg {...p}>
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
    <m.path d="M8 17v-3" custom={0} variants={DRAW} />
    <m.path d="M13 17V5" custom={1} variants={DRAW} />
    <m.path d="M18 17V9" custom={2} variants={DRAW} />
  </Svg>
))

// Status: the heartbeat trace redraws, like a fresh reading coming in.
const TRACE: Variants = {
  normal: { pathLength: 1, opacity: 1, transition: OUT },
  animate: {
    pathLength: [0, 1],
    opacity: [0.4, 1],
    transition: { pathLength: IN, opacity: { duration: 0.2 } },
  },
}
export const ActivityIcon = define("ActivityIcon", (p) => (
  <Svg {...p}>
    <m.path
      d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"
      variants={TRACE}
    />
  </Svg>
))

// Webhooks: the three hooks draw in turn, a payload going round the loop.
export const WebhookIcon = define("WebhookIcon", (p) => (
  <Svg {...p}>
    <m.path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" custom={0} variants={DRAW} />
    <m.path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" custom={1} variants={DRAW} />
    <m.path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" custom={2} variants={DRAW} />
  </Svg>
))

// Integrations: the plug pushes up into a socket and settles.
const PLUG: Variants = {
  normal: { y: 0, transition: OUT },
  animate: { y: [0, -3, 0, -1, 0], transition: IN },
}
export const PlugIcon = define("PlugIcon", (p) => (
  <Svg {...p}>
    <m.g variants={PLUG}>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </m.g>
  </Svg>
))

// Emails: the flap dips as if the envelope is being opened.
const FLAP: Variants = {
  normal: { y: 0, transition: OUT },
  animate: { y: [0, 2.5, 0], transition: IN },
}
export const MailIcon = define("MailIcon", (p) => (
  <Svg {...p}>
    <m.path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" variants={FLAP} />
    <rect x="2" y="4" width="20" height="16" rx="2" />
  </Svg>
))

// SMS: the bubble pops in from its tail, like a message arriving.
const BUBBLE: Variants = {
  normal: { scale: 1, rotate: 0, transition: OUT },
  animate: { scale: [1, 1.15, 0.95, 1], rotate: [0, -6, 3, 0], transition: IN },
}
export const MessageSquareIcon = define("MessageSquareIcon", (p) => (
  <Svg {...p} variants={BUBBLE} style={{ originX: 0.1, originY: 0.9 }}>
    <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
  </Svg>
))

// Domain Intel: the rosette swings on its ribbon like a pinned medal.
const MEDAL: Variants = {
  normal: { rotate: 0, transition: OUT },
  animate: { rotate: [0, -18, 12, -6, 2, 0], transition: { ...IN, duration: 0.8 } },
}
export const FileBadgeIcon = define("FileBadgeIcon", (p) => (
  <Svg {...p}>
    <path d="M12 22h6a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3.072" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <m.g variants={MEDAL} style={{ originX: 0.5, originY: 0 }}>
      <circle cx="5" cy="14" r="3" />
      <path d="m6.69 16.479 1.29 4.88a.5.5 0 0 1-.698.591l-1.843-.849a1 1 0 0 0-.88.001l-1.846.85a.5.5 0 0 1-.693-.593l1.29-4.88" />
    </m.g>
  </Svg>
))

// Logs: the lid lifts off the stack for a look inside.
const LID: Variants = {
  normal: { y: 0, transition: OUT },
  animate: { y: [0, -2.5, 0], transition: IN },
}
export const DatabaseIcon = define("DatabaseIcon", (p) => (
  <Svg {...p}>
    <m.ellipse cx="12" cy="5" rx="9" ry="3" variants={LID} />
    <path d="M3 5V19A9 3 0 0 0 21 19V5" />
    <path d="M3 12A9 3 0 0 0 21 12" />
  </Svg>
))

// API: the brackets breathe apart and back together.
const BRACKET: Variants = {
  normal: { x: 0, transition: OUT },
  animate: (dir: number) => ({ x: [0, 2 * dir, 0], transition: IN }),
}
export const CodeIcon = define("CodeIcon", (p) => (
  <Svg {...p}>
    <m.path d="m16 18 6-6-6-6" custom={1} variants={BRACKET} />
    <m.path d="m8 6-6 6 6 6" custom={-1} variants={BRACKET} />
  </Svg>
))

// MCP: the bot tilts its head and blinks.
const HEAD: Variants = {
  normal: { rotate: 0, transition: OUT },
  animate: { rotate: [0, -10, 8, 0], transition: IN },
}
const BLINK: Variants = {
  normal: { scaleY: 1, transition: OUT },
  animate: { scaleY: [1, 0.1, 1], transition: { duration: 0.25, delay: 0.3 } },
}
export const BotIcon = define("BotIcon", (p) => (
  <Svg {...p} variants={HEAD}>
    <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <m.path d="M15 13v2" variants={BLINK} />
    <m.path d="M9 13v2" variants={BLINK} />
  </Svg>
))

// Team: the people bob in turn, front one first.
const PERSON: Variants = {
  normal: { y: 0, transition: OUT },
  animate: (i: number) => ({ y: [0, -2, 0], transition: { ...IN, duration: 0.5, delay: i * 0.12 } }),
}
export const UsersRoundIcon = define("UsersRoundIcon", (p) => (
  <Svg {...p}>
    <m.g custom={0} variants={PERSON}>
      <path d="M18 21a8 8 0 0 0-16 0" />
      <circle cx="10" cy="8" r="5" />
    </m.g>
    <m.path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" custom={1} variants={PERSON} />
  </Svg>
))

// Billing: the card tips forward as the stripe is swiped.
const CARD: Variants = {
  normal: { rotate: 0, transition: OUT },
  animate: { rotate: [0, -8, 0], transition: IN },
}
export const CreditCardIcon = define("CreditCardIcon", (p) => (
  <Svg {...p} variants={CARD}>
    <rect width="20" height="14" x="2" y="5" rx="2" />
    <m.line x1="2" x2="22" y1="10" y2="10" variants={DRAW} />
  </Svg>
))

// Docs: the book flexes open from its spine.
const PAGES: Variants = {
  normal: { scaleX: 1, transition: OUT },
  animate: { scaleX: [1, 1.12, 0.94, 1], transition: IN },
}
export const BookOpenIcon = define("BookOpenIcon", (p) => (
  <Svg {...p}>
    <path d="M12 7v14" />
    <m.path
      d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"
      variants={PAGES}
    />
  </Svg>
))

// Admin Dashboard: the shield pulses once, like a guard standing to attention.
const GUARD: Variants = {
  normal: { scale: 1, transition: OUT },
  animate: { scale: [1, 0.85, 1.1, 1], transition: IN },
}
export const ShieldIcon = define("ShieldIcon", (p) => (
  <Svg {...p} variants={GUARD}>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  </Svg>
))

// System Notifications: the bell rocks from its crown and the clapper lags a
// beat behind, which is what makes it read as a bell and not a tilting shape.
const BELL: Variants = {
  normal: { rotate: 0, transition: OUT },
  animate: { rotate: [0, -12, 10, -8, 5, -2, 0], transition: { ...IN, duration: 0.8 } },
}
const CLAPPER: Variants = {
  normal: { x: 0, transition: OUT },
  animate: { x: [0, 1.4, -1.2, 0.9, -0.5, 0], transition: { ...IN, duration: 0.8, delay: 0.05 } },
}
export const BellIcon = define("BellIcon", (p) => (
  <Svg {...p} variants={BELL} style={{ originX: 0.5, originY: 0.12 }}>
    <m.path d="M10.268 21a2 2 0 0 0 3.464 0" variants={CLAPPER} />
    <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
  </Svg>
))

// User Admin: same bob as Team, for the square-shouldered version.
export const UsersIcon = define("UsersIcon", (p) => (
  <Svg {...p}>
    <m.g custom={0} variants={PERSON}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
    </m.g>
    <m.g custom={1} variants={PERSON}>
      <path d="M16 3.128a4 4 0 0 1 0 7.744" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    </m.g>
  </Svg>
))

// Onboarding Responses: the answers get written in, line by line.
export const ClipboardListIcon = define("ClipboardListIcon", (p) => (
  <Svg {...p}>
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <m.path d="M12 11h4" custom={0} variants={DRAW} />
    <m.path d="M12 16h4" custom={2} variants={DRAW} />
    <path d="M8 11h.01" />
    <path d="M8 16h.01" />
  </Svg>
))

// Discord: the logo hops, as if someone just joined the voice channel.
const HOP: Variants = {
  normal: { y: 0, rotate: 0, transition: OUT },
  animate: { y: [0, -3, 0, -1, 0], rotate: [0, -6, 4, 0, 0], transition: IN },
}
export const DiscordIcon = define("DiscordIcon", (p) => (
  <Svg {...p} variants={HOP} viewBox="0 0 512 365.467">
    <path
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M378.186 365.028s-15.794-18.865-28.956-35.099c57.473-16.232 79.41-51.77 79.41-51.77-17.989 11.846-35.099 20.182-50.454 25.885-21.938 9.213-42.997 14.917-63.617 18.866-42.118 7.898-80.726 5.703-113.631-.438-25.008-4.827-46.506-11.407-64.494-18.867-10.091-3.947-21.059-8.774-32.027-14.917-1.316-.877-2.633-1.316-3.948-2.193-.877-.438-1.316-.878-1.755-.878-7.898-4.388-12.285-7.458-12.285-7.458s21.06 34.659 76.779 51.331c-13.163 16.673-29.395 35.977-29.395 35.977C36.854 362.395 0 299.218 0 299.218 0 159.263 63.177 45.633 63.177 45.633 126.354-1.311 186.022.005 186.022.005l4.388 5.264C111.439 27.645 75.461 62.305 75.461 62.305s9.653-5.265 25.886-12.285c46.945-20.621 84.236-25.885 99.592-27.64 2.633-.439 4.827-.878 7.458-.878 26.763-3.51 57.036-4.387 88.624-.878 41.68 4.826 86.43 17.111 132.058 41.68 0 0-34.66-32.906-109.244-55.281l6.143-7.019s60.105-1.317 122.844 45.628c0 0 63.178 113.631 63.178 253.585 0-.438-36.854 62.739-133.813 65.81l-.001.001zm-43.874-203.133c-25.006 0-44.75 21.498-44.75 48.262 0 26.763 20.182 48.26 44.75 48.26 25.008 0 44.752-21.497 44.752-48.26 0-26.764-20.182-48.262-44.752-48.262zm-160.135 0c-25.008 0-44.751 21.498-44.751 48.262 0 26.763 20.182 48.26 44.751 48.26 25.007 0 44.75-21.497 44.75-48.26.439-26.763-19.742-48.262-44.75-48.262z"
    />
  </Svg>
))
