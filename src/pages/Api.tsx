import * as React from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, BookOpen, Code, Copy, KeyRound, ShieldCheck } from "lucide-react";

import { PageContainer, PageHeader, DocsLink } from "@/components/layout";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  ScrollArea,
  Separator,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/utils/clipboard";

const DEFAULT_PUBLIC_API_BASE_URL = "https://us-central1-exit1-dev.cloudfunctions.net/publicApi";

function getPublicApiBaseUrl() {
  const envBase = import.meta.env.VITE_PUBLIC_API_BASE_URL as string | undefined;
  return (envBase || DEFAULT_PUBLIC_API_BASE_URL).replace(/\/+$/, "");
}

function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function CodeBlock({
  code,
  className,
  copyLabel = "Copy",
}: {
  code: string;
  className?: string;
  copyLabel?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  async function onCopy() {
    const ok = await copyToClipboard(code);
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 900);
  }

  return (
    <div
      className={cn(
        "rounded-md border border-sky-500/20 bg-black/40 backdrop-blur",
        className
      )}
    >
      <div className="flex items-center justify-end gap-2 border-b border-sky-500/15 px-3 py-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={onCopy}
          className="h-7 gap-1 px-2 cursor-pointer"
        >
          <Copy className="h-3.5 w-3.5" />
          {copied ? "Copied" : copyLabel}
        </Button>
      </div>
      <pre className="overflow-auto p-3 text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

type Param = {
  name: string;
  type: string;
  required?: boolean;
  description: string;
};

type Endpoint = {
  id: string;
  method: "GET";
  path: string;
  title: string;
  description: string;
  queryParams?: Param[];
  responseNotes?: string;
  exampleCurl: (baseUrl: string) => string;
  exampleJs: (baseUrl: string) => string;
  examplePython: (baseUrl: string) => string;
  exampleResponse: string;
};

function MethodBadge({ method }: { method: Endpoint["method"] }) {
  return (
    <Badge className="border-emerald-500/30 bg-emerald-500/15 text-emerald-200">
      {method}
    </Badge>
  );
}

function ParamsTable({ params }: { params: Param[] }) {
  return (
    <div className="w-full overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Param</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Required</TableHead>
            <TableHead>Description</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {params.map((p) => (
            <TableRow key={p.name}>
              <TableCell className="font-mono text-xs">{p.name}</TableCell>
              <TableCell className="text-xs">{p.type}</TableCell>
              <TableCell className="text-xs">{p.required ? "Yes" : "No"}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{p.description}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function EndpointCard({ endpoint, baseUrl }: { endpoint: Endpoint; baseUrl: string }) {
  const curl = endpoint.exampleCurl(baseUrl);
  const js = endpoint.exampleJs(baseUrl);
  const py = endpoint.examplePython(baseUrl);

  return (
    <Card id={endpoint.id} className="border-sky-500/30 bg-sky-500/5 backdrop-blur scroll-mt-24">
      <CardHeader className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <MethodBadge method={endpoint.method} />
              <span className="truncate">{endpoint.title}</span>
            </CardTitle>
            <CardDescription className="mt-1">{endpoint.description}</CardDescription>
          </div>
          <div className="shrink-0">
            <Badge variant="secondary" className="font-mono text-xs">
              {endpoint.path}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {endpoint.queryParams && endpoint.queryParams.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Query parameters</div>
            <ParamsTable params={endpoint.queryParams} />
          </div>
        )}

        <div className="space-y-2">
          <div className="text-sm font-medium">Examples</div>
          <Tabs defaultValue="curl">
            <TabsList>
              <TabsTrigger value="curl" className="cursor-pointer">
                cURL
              </TabsTrigger>
              <TabsTrigger value="js" className="cursor-pointer">
                JavaScript
              </TabsTrigger>
              <TabsTrigger value="python" className="cursor-pointer">
                Python
              </TabsTrigger>
            </TabsList>
            <TabsContent value="curl" className="mt-3">
              <CodeBlock code={curl} />
            </TabsContent>
            <TabsContent value="js" className="mt-3">
              <CodeBlock code={js} />
            </TabsContent>
            <TabsContent value="python" className="mt-3">
              <CodeBlock code={py} />
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">Response</div>
          {endpoint.responseNotes && (
            <div className="text-xs text-muted-foreground">{endpoint.responseNotes}</div>
          )}
          <CodeBlock code={endpoint.exampleResponse} copyLabel="Copy JSON" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function Api() {
  const baseUrl = React.useMemo(() => getPublicApiBaseUrl(), []);
  const [navOpen, setNavOpen] = React.useState(false);

  const endpoints: Endpoint[] = React.useMemo(
    () => [
      {
        id: "get-checks",
        method: "GET",
        path: "/v1/public/checks",
        title: "List checks",
        description:
          "Returns the checks owned by the API key's user. Supports cursor or page-based pagination and optional status filtering.",
        queryParams: [
          { name: "limit", type: "number", required: false, description: "Max 100. Default 25." },
          { name: "page", type: "number", required: false, description: "1-based page. Default 1." },
          { name: "cursor", type: "string", required: false, description: "Base64 cursor from meta.nextCursor. When set, page is ignored." },
          {
            name: "status",
            type: "string",
            required: false,
            description: "Filter by status; use 'all' to disable filtering (default).",
          },
          { name: "includeTotal", type: "boolean", required: false, description: "Set false to skip total count (reduces reads). Default true." },
        ],
        exampleCurl: (b) =>
          `curl -H "X-Api-Key: YOUR_KEY" "${b}/v1/public/checks?limit=25&status=all"`,
        exampleJs: (b) =>
          `const res = await fetch("${b}/v1/public/checks?limit=25&status=all", {\n  headers: { "X-Api-Key": process.env.EXIT1_API_KEY! },\n});\nconst json = await res.json();\nconsole.log(json.data, json.meta);\n\n// Use meta.nextCursor for the next page\n// const next = await fetch("${b}/v1/public/checks?limit=25&status=all&cursor=" + encodeURIComponent(json.meta.nextCursor), { headers: { "X-Api-Key": process.env.EXIT1_API_KEY! } });`,
        examplePython: (b) =>
          `import os, requests\n\nr = requests.get(\n  "${b}/v1/public/checks",\n  params={ "limit": 25, "status": "all" },\n  headers={ "X-Api-Key": os.environ["EXIT1_API_KEY"] },\n)\nr.raise_for_status()\nprint(r.json())`,
        responseNotes: "200 OK. Response is paginated with a meta object.",
        exampleResponse: `{\n  "data": [\n    {\n      "id": "CHECK_ID",\n      "name": "Homepage",\n      "url": "https://example.com",\n      "status": "online",\n      "lastChecked": 1734700000000,\n      "responseTime": 123,\n      "lastStatusCode": 200,\n      "disabled": false,\n      "sslCertificate": null,\n      "createdAt": 1730000000000,\n      "updatedAt": 1734700000000\n    }\n  ],\n  "meta": {\n    "page": 1,\n    "limit": 25,\n    "total": 1,\n    "totalPages": 1,\n    "hasNext": false,\n    "hasPrev": false,\n    "nextCursor": "eyJvcmRlckluZGV4IjowLCJpZCI6IkNIRUNLX0lEIn0="\n  }\n}`,
      },
      {
        id: "get-check",
        method: "GET",
        path: "/v1/public/checks/:id",
        title: "Get a check",
        description: "Fetch a single check by ID. Only accessible to the key's owner.",
        exampleCurl: (b) =>
          `curl -H "X-Api-Key: YOUR_KEY" "${b}/v1/public/checks/CHECK_ID"`,
        exampleJs: (b) =>
          `const checkId = "CHECK_ID";\nconst res = await fetch(\n  "${b}/v1/public/checks/" + encodeURIComponent(checkId),\n  { headers: { "X-Api-Key": process.env.EXIT1_API_KEY! } }\n);\nconsole.log(await res.json());`,
        examplePython: (b) =>
          `import os, requests\n\ncheck_id = "CHECK_ID"\nr = requests.get(\n  f"${b}/v1/public/checks/{check_id}",\n  headers={ "X-Api-Key": os.environ["EXIT1_API_KEY"] },\n)\nr.raise_for_status()\nprint(r.json())`,
        responseNotes: "200 OK. 404 if missing. 403 if not owned by the API key user.",
        exampleResponse: `{\n  "data": {\n    "id": "CHECK_ID",\n    "name": "Homepage",\n    "url": "https://example.com",\n    "status": "online",\n    "lastChecked": 1734700000000,\n    "responseTime": 123,\n    "lastStatusCode": 200,\n    "disabled": false,\n    "sslCertificate": null,\n    "createdAt": 1730000000000,\n    "updatedAt": 1734700000000\n  }\n}`,
      },
      {
        id: "get-history",
        method: "GET",
        path: "/v1/public/checks/:id/history",
        title: "Get check history",
        description:
          "Fetch check history from BigQuery. Supports pagination, date range filtering, status filtering, and search.",
        queryParams: [
          { name: "limit", type: "number", required: false, description: "Max 200. Default 25." },
          { name: "page", type: "number", required: false, description: "1-based page. Default 1." },
          { name: "cursor", type: "string", required: false, description: "Base64 cursor from meta.nextCursor. When set, page is ignored." },
          {
            name: "from",
            type: "string|number",
            required: false,
            description: "Start time (ISO 8601 or Unix timestamp).",
          },
          {
            name: "to",
            type: "string|number",
            required: false,
            description: "End time (ISO 8601 or Unix timestamp).",
          },
          {
            name: "status",
            type: "string",
            required: false,
            description: "Filter by status; use 'all' to disable filtering (default).",
          },
          { name: "includeTotal", type: "boolean", required: false, description: "Set false to skip total count (reduces reads). Default true." },
          { name: "q", type: "string", required: false, description: "Search term (matches status or error)." },
        ],
        exampleCurl: (b) =>
          `curl -H "X-Api-Key: YOUR_KEY" "${b}/v1/public/checks/CHECK_ID/history?limit=50&page=1&from=2023-12-21T22:30:56Z&to=2023-12-22T22:30:56Z&status=all&q="`,
        exampleJs: (b) =>
          `const checkId = "CHECK_ID";\nconst url = new URL("${b}/v1/public/checks/" + encodeURIComponent(checkId) + "/history");\nurl.searchParams.set("limit", "50");\nurl.searchParams.set("page", "1");\nurl.searchParams.set("from", "2023-12-21T22:30:56Z");\nurl.searchParams.set("to", "2023-12-22T22:30:56Z");\nurl.searchParams.set("status", "all");\n\nconst res = await fetch(url, { headers: { "X-Api-Key": process.env.EXIT1_API_KEY! } });\nconsole.log(await res.json());`,
        examplePython: (b) =>
          `import os, requests\n\ncheck_id = "CHECK_ID"\nr = requests.get(\n  f"${b}/v1/public/checks/{check_id}/history",\n  params={\n    "limit": 50,\n    "page": 1,\n    "from": "2023-12-21T22:30:56Z",\n    "to": "2023-12-22T22:30:56Z",\n    "status": "all",\n    "q": "",\n  },\n  headers={ "X-Api-Key": os.environ["EXIT1_API_KEY"] },\n)\nr.raise_for_status()\nprint(r.json())`,
        responseNotes: "200 OK. Response is paginated with a meta object.",
        exampleResponse: `{\n  "data": [\n    {\n      "id": "HISTORY_ID",\n      "websiteId": "CHECK_ID",\n      "userId": "USER_ID",\n      "timestamp": 1734700000000,\n      "status": "online",\n      "responseTime": 123,\n      "statusCode": 200,\n      "error": null,\n      "createdAt": 1734700000000\n    }\n  ],\n  "meta": {\n    "page": 1,\n    "limit": 50,\n    "total": 1,\n    "totalPages": 1,\n    "hasNext": false,\n    "hasPrev": false\n  }\n}`,
      },
      {
        id: "get-stats",
        method: "GET",
        path: "/v1/public/checks/:id/stats",
        title: "Get check stats",
        description: "Returns aggregated uptime + response time statistics from BigQuery.",
        queryParams: [
          {
            name: "from",
            type: "string|number",
            required: false,
            description: "Start time (ISO 8601 or Unix timestamp).",
          },
          {
            name: "to",
            type: "string|number",
            required: false,
            description: "End time (ISO 8601 or Unix timestamp).",
          },
        ],
        exampleCurl: (b) =>
          `curl -H "X-Api-Key: YOUR_KEY" "${b}/v1/public/checks/CHECK_ID/stats?from=2023-12-21T22:30:56Z&to=2023-12-22T22:30:56Z"`,
        exampleJs: (b) =>
          `const checkId = "CHECK_ID";\nconst res = await fetch(\n  "${b}/v1/public/checks/" + encodeURIComponent(checkId) + "/stats?from=2023-12-21T22:30:56Z&to=2023-12-22T22:30:56Z",\n  { headers: { "X-Api-Key": process.env.EXIT1_API_KEY! } }\n);\nconsole.log(await res.json());`,
        examplePython: (b) =>
          `import os, requests\n\ncheck_id = "CHECK_ID"\nr = requests.get(\n  f"${b}/v1/public/checks/{check_id}/stats",\n  params={ "from": "2023-12-21T22:30:56Z", "to": "2023-12-22T22:30:56Z" },\n  headers={ "X-Api-Key": os.environ["EXIT1_API_KEY"] },\n)\nr.raise_for_status()\nprint(r.json())`,
        responseNotes:
          "200 OK. If no history exists in the window, counts may be 0 and response times 0.",
        exampleResponse:
          `{\n  "data": {\n    "totalChecks": 1200,\n    "onlineChecks": 1196,\n    "offlineChecks": 4,\n    "uptimePercentage": 99.884,\n    "totalDurationMs": 86400000,\n    "onlineDurationMs": 86300000,\n    "offlineDurationMs": 100000,\n    "responseSampleCount": 1200,\n    "avgResponseTime": 151.2,\n    "minResponseTime": 45,\n    "maxResponseTime": 982\n  }\n}`,
      },
    ],
    []
  );

  const [filter, setFilter] = React.useState("");
  const filteredEndpoints = endpoints.filter((e) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return (
      e.title.toLowerCase().includes(q) ||
      e.path.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q)
    );
  });

  const sectionLinks = [
    { id: "overview", label: "Overview", icon: BookOpen },
    { id: "auth", label: "Authentication", icon: ShieldCheck },
    { id: "pagination", label: "Pagination & time ranges", icon: BookOpen },
    { id: "rate-limits", label: "Rate limits", icon: BookOpen },
    { id: "errors", label: "Errors", icon: AlertTriangle },
    { id: "reference", label: "Reference", icon: Code },
  ] as const;

  function navigateTo(id: string) {
    // Keep it simple: close the sheet, then scroll after the close animation.
    setNavOpen(false);
    window.setTimeout(() => scrollToId(id), 350);
  }

  const NavContent = (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-sm font-medium">Docs</div>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search endpoints…"
        />
      </div>

      <div className="space-y-1">
        {sectionLinks.map((s) => (
          <Button
            key={s.id}
            variant="ghost"
            className="w-full justify-start gap-2 cursor-pointer"
            onClick={() => navigateTo(s.id)}
          >
            <s.icon className="h-4 w-4" />
            {s.label}
          </Button>
        ))}
      </div>

      <Separator />

      <div className="space-y-1">
        <div className="px-2 text-xs font-medium text-muted-foreground">Reference</div>
        {filteredEndpoints.map((e) => (
          <Button
            key={e.id}
            variant="ghost"
            className="w-full justify-start cursor-pointer"
            onClick={() => navigateTo(e.id)}
          >
            <span className="mr-2 inline-flex w-10 justify-center">
              <Badge className="border-emerald-500/30 bg-emerald-500/15 text-emerald-200">
                GET
              </Badge>
            </span>
            <span className="truncate font-mono text-xs">{e.path}</span>
          </Button>
        ))}
        {filteredEndpoints.length === 0 && (
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">No matches.</div>
        )}
      </div>
    </div>
  );

  return (
    <PageContainer className="overflow-visible">
      <PageHeader
        title="API"
        description="Everything you need to integrate with exit1.dev"
        icon={Code}
        actions={
          <div className="flex items-center gap-2">
            <DocsLink path="/api-reference" label="API reference docs" />
            <Sheet open={navOpen} onOpenChange={setNavOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" className="cursor-pointer md:hidden">
                  Browse docs
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                className="w-[320px] sm:w-[380px] p-0 bg-sky-950/40 backdrop-blur border-sky-500/20"
              >
                <div className="px-6 pt-6 pb-4 border-b border-sky-500/20">
                  <SheetHeader className="space-y-1">
                    <SheetTitle>API docs</SheetTitle>
                    <div className="text-sm text-muted-foreground">Navigate sections and endpoints</div>
                  </SheetHeader>
                </div>

                <ScrollArea className="h-[calc(100vh-7.5rem)]">
                  <div className="px-6 py-4">{NavContent}</div>
                </ScrollArea>
              </SheetContent>
            </Sheet>

            <Button asChild variant="secondary" className="cursor-pointer">
              <Link to="/api-keys" className="inline-flex items-center gap-2">
                <KeyRound className="h-4 w-4" />
                API keys
              </Link>
            </Button>
          </div>
        }
      />

      <div className="p-4 sm:p-6">
          <div className="mx-auto max-w-6xl">
            <div className="grid gap-6 md:grid-cols-[280px_1fr]">
              <aside className="hidden md:block md:sticky md:top-16 md:self-start">
                <Card className="border-sky-500/30 bg-sky-500/5 backdrop-blur">
                  <CardHeader className="space-y-3">
                    <CardTitle className="text-base">Docs</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="pr-1">{NavContent}</div>
                  </CardContent>
                </Card>
              </aside>

              <div className="min-w-0 space-y-6">
            <Card id="overview" className="border-sky-500/30 bg-sky-500/5 backdrop-blur scroll-mt-24">
              <CardHeader>
                <CardTitle>Overview</CardTitle>
                <CardDescription>
                  The exit1.dev Public API is a simple, read-only REST API for checks, history, and stats.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-sm">
                  <span className="font-medium">Base URL:</span>{" "}
                  <span className="font-mono text-xs">{baseUrl}</span>
                </div>
                <div className="text-sm">
                  <span className="font-medium">Versioning:</span>{" "}
                  <span className="text-muted-foreground">Endpoints are versioned under</span>{" "}
                  <span className="font-mono text-xs">/v1</span>.
                </div>
                <div className="text-sm">
                  <span className="font-medium">Methods:</span>{" "}
                  <span className="text-muted-foreground">Currently</span>{" "}
                  <Badge className="border-emerald-500/30 bg-emerald-500/15 text-emerald-200">
                    GET
                  </Badge>{" "}
                  <span className="text-muted-foreground">only.</span>
                </div>
              </CardContent>
            </Card>

            <Card id="auth" className="border-sky-500/30 bg-sky-500/5 backdrop-blur scroll-mt-24">
              <CardHeader>
                <CardTitle>Authentication</CardTitle>
                <CardDescription>Authenticate using an API key in the request header.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-sm">
                  Add header:{" "}
                  <code className="px-1 py-0.5 rounded bg-black/40">X-Api-Key: YOUR_KEY</code>
                </div>
                <CodeBlock
                  code={`curl -H "X-Api-Key: YOUR_KEY" "${baseUrl}/v1/public/checks?limit=25"`}
                />
                <Alert className="border-sky-500/30 bg-sky-950/40 backdrop-blur">
                  <KeyRound className="h-4 w-4 text-sky-200" />
                  <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                    <span>
                      <strong className="font-semibold">API keys are managed on a separate page.</strong>{" "}
                      Create, revoke, and rotate keys from your account.
                    </span>
                    <Button asChild variant="secondary" className="cursor-pointer shrink-0">
                      <Link to="/api-keys">Manage API keys</Link>
                    </Button>
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>

            <Card
              id="pagination"
              className="border-sky-500/30 bg-sky-500/5 backdrop-blur scroll-mt-24"
            >
              <CardHeader>
                <CardTitle>Pagination &amp; time ranges</CardTitle>
                <CardDescription>How to page results and filter by time.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-sm">
                  List endpoints return a <code className="px-1 py-0.5 rounded bg-black/40">meta</code>{" "}
                  object with <code className="px-1 py-0.5 rounded bg-black/40">page</code>,{" "}
                  <code className="px-1 py-0.5 rounded bg-black/40">limit</code>,{" "}
                  <code className="px-1 py-0.5 rounded bg-black/40">total</code>, and{" "}
                  <code className="px-1 py-0.5 rounded bg-black/40">hasNext</code>.
                </div>
                <div className="text-sm">
                  For history/stats, <code className="px-1 py-0.5 rounded bg-black/40">from</code> and{" "}
                  <code className="px-1 py-0.5 rounded bg-black/40">to</code> accept either ISO 8601
                  (recommended) or a Unix timestamp.
                </div>
                <CodeBlock
                  code={`curl -H "X-Api-Key: YOUR_KEY" "${baseUrl}/v1/public/checks/CHECK_ID/history?limit=50&page=1&from=2023-12-21T22:30:56Z&to=2023-12-22T22:30:56Z"`}
                />
              </CardContent>
            </Card>

            <Card
              id="rate-limits"
              className="border-sky-500/30 bg-sky-500/5 backdrop-blur scroll-mt-24"
            >
              <CardHeader>
                <CardTitle>Rate limits</CardTitle>
                <CardDescription>Be a good citizen.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-sm text-muted-foreground">
                  We enforce rate limits to keep the Public API reliable and affordable. Limits are intentionally
                  strict to protect the data and keep costs in check, and may change over time.
                </div>

                <div className="space-y-2 text-sm">
                  <div className="font-medium">Current limits (free tier)</div>
                  <div className="text-muted-foreground mt-2">Per-minute limits:</div>
                  <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
                    <li>
                      <span className="font-medium text-foreground">Pre-auth (per IP):</span> 20 requests/minute
                      to slow down abuse and API key guessing.
                    </li>
                    <li>
                      <span className="font-medium text-foreground">Per API key (total):</span> 5 requests/minute across all endpoints.
                    </li>
                    <li>
                      <span className="font-medium text-foreground">Per endpoint:</span> 1 request/minute per endpoint.
                    </li>
                  </ul>
                  <div className="text-muted-foreground mt-3">Daily quotas:</div>
                  <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
                    <li>
                      <span className="font-medium text-foreground">Per API key:</span> 500 requests/day
                    </li>
                    <li>
                      <span className="font-medium text-foreground">Per user (all keys):</span> 2,000 requests/day
                    </li>
                  </ul>
                </div>

                <div className="space-y-2 text-sm">
                  <div className="font-medium">When you exceed the limit</div>
                  <div className="text-muted-foreground">
                    You&apos;ll receive <code className="px-1 py-0.5 rounded bg-black/40">429</code> with{" "}
                    <code className="px-1 py-0.5 rounded bg-black/40">Retry-After</code> and{" "}
                    <code className="px-1 py-0.5 rounded bg-black/40">RateLimit-*</code> headers to help you back off.
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card id="errors" className="border-sky-500/30 bg-sky-500/5 backdrop-blur scroll-mt-24">
              <CardHeader>
                <CardTitle>Errors</CardTitle>
                <CardDescription>Errors are returned as JSON: <code className="px-1 py-0.5 rounded bg-black/40">{"{ error: string }"}</code></CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="w-full overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Status</TableHead>
                        <TableHead>Meaning</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell className="font-mono text-xs">401</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          Missing, invalid, or disabled API key
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-mono text-xs">403</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          Resource not owned by the API key user
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-mono text-xs">404</TableCell>
                        <TableCell className="text-sm text-muted-foreground">Not found</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-mono text-xs">405</TableCell>
                        <TableCell className="text-sm text-muted-foreground">Method not allowed</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-mono text-xs">429</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          Rate limit exceeded (see <span className="font-medium text-foreground">Rate limits</span> above)
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-mono text-xs">500</TableCell>
                        <TableCell className="text-sm text-muted-foreground">Internal error</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-medium">Example</div>
                  <CodeBlock code={`{ "error": "Missing X-Api-Key" }`} copyLabel="Copy JSON" />
                </div>
              </CardContent>
            </Card>

            <div id="reference" className="scroll-mt-24">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold">Reference</div>
                  <div className="text-sm text-muted-foreground">Endpoints for checks, history, and stats.</div>
                </div>
              </div>
              <Separator className="my-4" />
              <div className="space-y-6">
                {endpoints.map((e) => (
                  <EndpointCard key={e.id} endpoint={e} baseUrl={baseUrl} />
                ))}
              </div>
            </div>
              </div>
            </div>
          </div>
        </div>
    </PageContainer>
  );
}




