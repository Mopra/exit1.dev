import { Badge, Tooltip, TooltipTrigger, TooltipContent, glassClasses } from '../ui';
import { SEVERITY_LABELS, isSeverity } from '../../lib/severity';

// P1/P2 get urgency colors matching their alerting weight; P3–P5 stay neutral
// so default-severity fleets don't turn the list into a warning wall.
const SEVERITY_BADGE_CLASSES: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'border-destructive/40 text-destructive',
  2: 'border-warning/40 text-warning',
  3: '',
  4: 'text-muted-foreground',
  5: 'text-muted-foreground/70',
};

/**
 * Compact P1–P5 badge for check lists. Renders nothing when severity is unset
 * (legacy checks without an explicit choice).
 */
export function SeverityBadge({ severity }: { severity?: number | null }) {
  if (!isSeverity(severity)) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={`font-mono text-[11px] w-fit cursor-default ${SEVERITY_BADGE_CLASSES[severity]}`}
        >
          P{severity}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className={glassClasses}>
        <span className="text-xs font-mono">Severity: {SEVERITY_LABELS[severity]}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export default SeverityBadge;
