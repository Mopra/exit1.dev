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
  children,
}: AnimatedIconProps & {
  variants?: Variants
  style?: React.ComponentProps<typeof m.svg>["style"]
  children: React.ReactNode
}) {
  const reduce = useReducedMotion()
  return (
    <m.svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
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
