import { useLocation, matchPath } from "react-router-dom";
import { Button } from "@/components/ui/Button";

const DOCS_BASE = "https://docs.exit1.dev";

const ROUTE_DOCS: Array<{ pattern: string; path: string; label: string }> = [
  { pattern: "/checks", path: "/monitoring", label: "Monitoring docs" },
  { pattern: "/checks/:checkId", path: "/monitoring", label: "Monitoring docs" },
  { pattern: "/check", path: "/monitoring", label: "Monitoring docs" },
  { pattern: "/webhooks", path: "/integrations/webhooks", label: "Webhook docs" },
  { pattern: "/emails", path: "/alerting/email-alerts", label: "Email alerts docs" },
  { pattern: "/sms", path: "/alerting/sms-alerts", label: "SMS alerts docs" },
  { pattern: "/logs", path: "/analytics/logs", label: "Logs docs" },
  { pattern: "/reports", path: "/analytics/reports", label: "Reports docs" },
  { pattern: "/api", path: "/api-reference", label: "API reference docs" },
  { pattern: "/api-keys", path: "/api-reference/authentication", label: "API authentication docs" },
  { pattern: "/billing", path: "/billing", label: "Billing docs" },
  { pattern: "/domain-intelligence", path: "/domain-intelligence", label: "Domain intelligence docs" },
  { pattern: "/status", path: "/status-pages", label: "Status pages docs" },
  { pattern: "/status/:checkId", path: "/status-pages", label: "Status pages docs" },
];

export function DocsLink() {
  const { pathname } = useLocation();
  const match = ROUTE_DOCS.find((r) => matchPath(r.pattern, pathname));
  const href = match ? `${DOCS_BASE}${match.path}` : DOCS_BASE;
  const label = match?.label ?? "View docs";

  return (
    <Button
      asChild
      variant="ghost"
      size="sm"
      className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
    >
      <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
        Docs
      </a>
    </Button>
  );
}
