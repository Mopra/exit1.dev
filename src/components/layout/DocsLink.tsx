import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
        >
          <a href={href} target="_blank" rel="noopener noreferrer">
            <BookOpen className="h-4 w-4" />
            <span className="sr-only">{label}</span>
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
