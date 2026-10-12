import * as React from "react";
import { BellRing, ExternalLink, Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { PageContainer, PageHeader } from "@/components/layout";
import { apiClient } from "@/api/client";
import type { PublicMonitorFollow } from "@/api/types";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";

// Same CDN-cached endpoint the marketing site's /status pages read. Absolute so
// it also works from the Vite dev server.
const CATALOG_URL = "https://app.exit1.dev/v1/public/monitors";
const STATUS_PAGE_URL = "https://exit1.dev/status";
const MAX_RESULTS = 12;

type CatalogEntry = {
  slug: string;
  name: string;
  host: string;
  status: string;
  uptime30d: number | null;
};

function isUp(status: string) {
  return status === "online" || status === "UP" || status === "REDIRECT";
}

function isDown(status: string) {
  return status === "offline" || status === "DOWN" || status === "REACHABLE_WITH_ERROR";
}

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        isUp(status) ? "bg-emerald-500" : isDown(status) ? "bg-red-500" : "bg-muted-foreground/40",
      )}
    />
  );
}

function formatUptime(value: number | null) {
  return value == null ? null : `${value.toFixed(value >= 99.995 ? 0 : 2)}% uptime`;
}

export default function Following() {
  const [follows, setFollows] = React.useState<PublicMonitorFollow[] | null>(null);
  const [catalog, setCatalog] = React.useState<CatalogEntry[] | null>(null);
  const [query, setQuery] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);

  const loadFollows = React.useCallback(async () => {
    const res = await apiClient.listPublicMonitorFollows();
    if (res.success && res.data) setFollows(res.data);
    else {
      setFollows([]);
      toast.error(res.error || "Failed to load followed services");
    }
  }, []);

  React.useEffect(() => {
    void loadFollows();
    fetch(CATALOG_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((json: { monitors?: CatalogEntry[] }) => setCatalog(json.monitors ?? []))
      .catch(() => setCatalog([]));
  }, [loadFollows]);

  const followedSlugs = React.useMemo(() => new Set((follows ?? []).map((f) => f.slug)), [follows]);

  const results = React.useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return catalog
      .filter((m) => m.name.toLowerCase().includes(q) || m.host.includes(q))
      .slice(0, MAX_RESULTS);
  }, [catalog, query]);

  async function follow(slug: string) {
    setBusy(slug);
    const res = await apiClient.followPublicMonitor(slug);
    setBusy(null);
    if (!res.success || !res.data) {
      toast.error(res.error || "Failed to follow this service");
      return;
    }
    const added = res.data;
    trackEvent("follow_service", { slug, source: "following_page" });
    setFollows((prev) =>
      [...(prev ?? []).filter((f) => f.slug !== added.slug), added].sort((a, b) => a.name.localeCompare(b.name)),
    );
    toast.success(`Following ${added.name}`);
  }

  async function unfollow(f: PublicMonitorFollow) {
    setBusy(f.slug);
    const res = await apiClient.unfollowPublicMonitor(f.checkId);
    setBusy(null);
    if (!res.success) {
      toast.error(res.error || "Failed to unfollow this service");
      return;
    }
    trackEvent("unfollow_service", { slug: f.slug });
    setFollows((prev) => (prev ?? []).filter((x) => x.checkId !== f.checkId));
  }

  return (
    <PageContainer>
      <PageHeader
        title="Following"
        description="Get an email when a service you depend on goes down, and when it's back"
        icon={BellRing}
      />
      <div className="w-full mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8 space-y-6">
        <Card className="bg-card border-0 shadow-lg">
          <CardHeader className="p-4 sm:p-6">
            <CardTitle className="text-xl flex items-center gap-2">
              <Plus className="h-5 w-5 text-primary" />
              Follow a service
            </CardTitle>
            <CardDescription>
              GitHub, npm, Stripe, Cloudflare and hundreds more. We already check them around the
              clock. Following is free and doesn&rsquo;t count against your plan.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0 pb-4 sm:pb-6 px-4 sm:px-6 space-y-3">
            <InputGroup>
              <InputGroupAddon>
                <Search className="size-4" />
              </InputGroupAddon>
              <InputGroupInput
                type="text"
                placeholder={catalog ? `Search ${catalog.length} services` : "Loading services..."}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={!catalog}
              />
            </InputGroup>
            {query.trim() && catalog && results.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nothing matches &ldquo;{query.trim()}&rdquo;. Ask for it in Discord, or add it as your own check.
              </p>
            )}
            {results.length > 0 && (
              <ul className="space-y-1">
                {results.map((m) => {
                  const following = followedSlugs.has(m.slug);
                  return (
                    <li key={m.slug} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/40">
                      <StatusDot status={m.status} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{m.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{m.host}</div>
                      </div>
                      <Button
                        size="sm"
                        variant={following ? "ghost" : "secondary"}
                        className="cursor-pointer"
                        disabled={following || busy === m.slug}
                        onClick={() => follow(m.slug)}
                      >
                        {busy === m.slug ? <Loader2 className="h-4 w-4 animate-spin" /> : following ? "Following" : "Follow"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-0 shadow-lg">
          <CardHeader className="p-4 sm:p-6">
            <CardTitle className="text-xl">Services you follow</CardTitle>
            <CardDescription>Alerts go to your account email.</CardDescription>
          </CardHeader>
          <CardContent className="pt-0 pb-4 sm:pb-6 px-4 sm:px-6">
            {follows === null ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading
              </div>
            ) : follows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                You don&rsquo;t follow anything yet. Search above to add the services your app depends on.
              </p>
            ) : (
              <ul className="space-y-1">
                {follows.map((f) => (
                  <li key={f.checkId} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/40">
                    <StatusDot status={f.status} />
                    <div className="min-w-0 flex-1">
                      <a
                        href={`${STATUS_PAGE_URL}/${encodeURIComponent(f.slug)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 truncate text-sm font-medium hover:underline cursor-pointer"
                      >
                        {f.name}
                        <ExternalLink className="h-3 w-3 text-muted-foreground" />
                      </a>
                      <div className="truncate text-xs text-muted-foreground">
                        {[f.host, formatUptime(f.uptime30d)].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="cursor-pointer text-muted-foreground"
                      disabled={busy === f.slug}
                      onClick={() => unfollow(f)}
                    >
                      {busy === f.slug ? <Loader2 className="h-4 w-4 animate-spin" /> : "Unfollow"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
