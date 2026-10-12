import * as React from "react";
import { useAccountId } from "@/AccountProvider";
import { Folder } from "lucide-react";

import { useChecks } from "@/hooks/useChecks";
import { folderHasPrefix, getAncestorPaths, normalizeFolder } from "@/lib/folder-utils";
import type { ApiKeyAccess } from "@/api/types";
import { Checkbox, Input } from "@/components/ui";

const noopLog = () => {};

interface KeyAccessPickerProps {
  value: ApiKeyAccess;
  onChange: (next: ApiKeyAccess) => void;
}

/**
 * Pick the checks and folders a restricted API key may use. A folder covers
 * its subfolders, so checks inside a selected folder show as included.
 * Mounted only while the create dialog is restricting a key, so the checks
 * fetch doesn't run for everyone who opens the API Keys page.
 */
export default function KeyAccessPicker({ value, onChange }: KeyAccessPickerProps) {
  const accountId = useAccountId();
  const { checks, loading } = useChecks(accountId, noopLog, { realtime: false });
  const [search, setSearch] = React.useState("");

  const folders = React.useMemo(() => {
    const all = new Set<string>();
    for (const c of checks) {
      const f = normalizeFolder(c.folder);
      if (!f) continue;
      all.add(f);
      for (const a of getAncestorPaths(f)) all.add(a);
    }
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [checks]);

  const q = search.trim().toLowerCase();
  const visibleFolders = q ? folders.filter((f) => f.toLowerCase().includes(q)) : folders;
  const visibleChecks = q
    ? checks.filter((c) =>
        [c.name, c.url, c.folder ?? ""].some((s) => s?.toLowerCase().includes(q)),
      )
    : checks;

  const coveredByFolder = (folder?: string | null) =>
    value.folders.some((granted) => folderHasPrefix(folder, granted));

  const toggle = (list: "checkIds" | "folders", item: string, on: boolean) => {
    const current = value[list];
    onChange({
      ...value,
      [list]: on ? [...current, item] : current.filter((x) => x !== item),
    });
  };

  if (loading) {
    return <div className="text-xs text-muted-foreground">Loading checks...</div>;
  }
  if (checks.length === 0) {
    return <div className="text-xs text-muted-foreground">You have no checks yet.</div>;
  }

  return (
    <div className="space-y-3">
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search checks and folders"
        className="h-8 text-sm"
      />
      <div className="max-h-64 overflow-y-auto rounded-md border border-border/50 divide-y divide-border/50">
        {visibleFolders.length > 0 && (
          <div className="p-2 space-y-1">
            <div className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Folders
            </div>
            {visibleFolders.map((f) => {
              const inherited = !value.folders.includes(f) && coveredByFolder(f);
              return (
                <label
                  key={f}
                  className="flex items-center gap-2 rounded px-1 py-1 text-sm cursor-pointer hover:bg-muted/40"
                >
                  <Checkbox
                    checked={value.folders.includes(f) || inherited}
                    disabled={inherited}
                    onCheckedChange={(v) => toggle("folders", f, !!v)}
                  />
                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{f}</span>
                </label>
              );
            })}
          </div>
        )}
        <div className="p-2 space-y-1">
          <div className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Checks
          </div>
          {visibleChecks.length === 0 && (
            <div className="px-1 py-1 text-xs text-muted-foreground">No matches.</div>
          )}
          {visibleChecks.map((c) => {
            const inherited = coveredByFolder(c.folder);
            return (
              <label
                key={c.id}
                className="flex items-center gap-2 rounded px-1 py-1 text-sm cursor-pointer hover:bg-muted/40"
              >
                <Checkbox
                  checked={inherited || value.checkIds.includes(c.id)}
                  disabled={inherited}
                  onCheckedChange={(v) => toggle("checkIds", c.id, !!v)}
                />
                <span className="truncate min-w-0">{c.name || c.url}</span>
                {c.folder && (
                  <span className="ml-auto shrink-0 truncate max-w-[40%] text-xs text-muted-foreground">
                    {c.folder}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        A folder includes its subfolders and any checks added to it later. The key can only create checks inside a selected folder, and can't change alert settings.
      </p>
    </div>
  );
}
