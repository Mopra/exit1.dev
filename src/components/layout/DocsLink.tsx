import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/Tooltip";

const DOCS_BASE = "https://docs.exit1.dev";

interface DocsLinkProps {
  /** Path relative to docs base URL, e.g. "/monitoring" */
  path?: string;
  /** Tooltip label override */
  label?: string;
}

export function DocsLink({ path = "", label = "View docs" }: DocsLinkProps) {
  const href = path ? `${DOCS_BASE}${path}` : DOCS_BASE;

  return (
    <>
      {/* Mobile: labeled text link */}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="sm:hidden text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
      >
        <BookOpen className="h-3.5 w-3.5" />
        Docs
      </a>
      {/* Desktop: icon-only with tooltip */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="hidden sm:inline-flex h-8 w-8 text-muted-foreground hover:text-foreground"
          >
            <a href={href} target="_blank" rel="noopener noreferrer">
              <BookOpen className="h-4 w-4" />
              <span className="sr-only">{label}</span>
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </>

  );
}
