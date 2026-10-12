import { cn } from "@/lib/utils"

/**
 * The exit1 mark, inline so it can move. It is a terminal prompt: an "e" and
 * a "_" caret. When the link or button around it is hovered (or the mark
 * itself), the "e" hops as if just typed and the caret blinks twice. Motion
 * lives in icon-motion.css under "Logo".
 *
 * `intro` plays the same gesture once on mount, for places where the logo is
 * a greeting rather than a link (onboarding).
 *
 * Drawn from public/e_.svg; keep the two in step if the mark changes.
 */
export function Logo({
  className,
  label = "exit1.dev",
  intro = false,
}: {
  className?: string
  label?: string
  intro?: boolean
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      role="img"
      aria-label={label}
      className={cn("exit1-logo shrink-0", intro && "exit1-logo-intro", className)}
    >
      <rect width="64" height="64" rx="14.2" ry="14.2" fill="#fff" />
      <path
        className="exit1-logo-e"
        d="M19.8,49.1c-3.7,0-6.5-1-8.4-3.1-1.9-2-2.9-4.8-2.9-8.4s.2-3.4.7-4.8c.5-1.5,1.2-2.7,2.1-3.7.9-1,2.1-1.8,3.4-2.3,1.3-.5,2.8-.8,4.5-.8s3.1.3,4.4.8c1.3.5,2.4,1.3,3.3,2.2.9,1,1.6,2.1,2.1,3.5.5,1.4.8,2.9.8,4.6v1.9h-15.1v.4c0,1.4.4,2.6,1.3,3.5.9.9,2.2,1.3,3.9,1.3s2.4-.2,3.4-.7c.9-.5,1.7-1.2,2.4-2l3.4,3.7c-.9,1.1-2,2-3.6,2.7-1.5.8-3.5,1.2-5.8,1.2ZM19.3,30.6c-1.4,0-2.5.4-3.3,1.3-.8.8-1.2,1.9-1.2,3.4v.3h8.9v-.3c0-1.5-.4-2.6-1.2-3.4-.8-.8-1.8-1.2-3.2-1.2Z"
      />
      <path className="exit1-logo-caret" d="M34.6,56.8v-5.2h20.5v5.2h-20.5Z" />
    </svg>
  )
}
