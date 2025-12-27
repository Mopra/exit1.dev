import React, { useCallback, useMemo } from "react";
import { Button, ScrollArea } from "../ui";
import type { Website } from "../../types";
import { cn } from "../../lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { toast } from "sonner";
import { ChevronRight, Folder, Globe, Plus } from "lucide-react";

type FolderKey = "__all__" | string;
type FolderOrderMap = Record<string, string[]>;

const ROOT_PARENT_KEY = "__root__";

function normalizeFolder(folder?: string | null): string | null {
  const raw = (folder ?? "").trim();
  if (!raw) return null;
  const cleaned = raw.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\s+/g, " ").trim();
  const trimmedSlashes = cleaned.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmedSlashes || null;
}

function splitFolderPath(folder: string): string[] {
  return folder.split("/").map((p) => p.trim()).filter(Boolean);
}

function joinPath(parts: string[]): string {
  return parts.join("/");
}

function getFolderDepth(path: string): number {
  if (!path) return 0;
  return splitFolderPath(path).length;
}

function getParentPath(path: string): string | null {
  const parts = splitFolderPath(path);
  if (parts.length <= 1) return null;
  return joinPath(parts.slice(0, -1));
}

type FolderNode = {
  name: string;
  path: string;
  children: Map<string, FolderNode>;
  checkCount: number;
};

function buildFolderTree(checks: Website[], customFolders: string[]) {
  const root: FolderNode = { name: "", path: "", children: new Map(), checkCount: 0 };
  const folderCounts = new Map<string, number>();

  for (const c of checks) {
    const folder = normalizeFolder(c.folder);
    if (!folder) {
      continue;
    }
    folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
    insertPath(root, folder);
  }

  for (const f of customFolders) {
    const normalized = normalizeFolder(f);
    if (!normalized) continue;
    insertPath(root, normalized);
  }

  const applyCounts = (node: FolderNode) => {
    if (node.path) node.checkCount = folderCounts.get(node.path) ?? 0;
    for (const child of node.children.values()) applyCounts(child);
  };
  applyCounts(root);

  return { root, folderCounts };
}

function insertPath(root: FolderNode, path: string) {
  const parts = splitFolderPath(path);
  let cursor = root;
  let pathParts: string[] = [];
  for (const part of parts) {
    pathParts.push(part);
    const fullPath = joinPath(pathParts);
    if (!cursor.children.has(part)) {
      cursor.children.set(part, { name: part, path: fullPath, children: new Map(), checkCount: 0 });
    }
    cursor = cursor.children.get(part)!;
  }
}

function sortNodes(nodes: FolderNode[]): FolderNode[] {
  return [...nodes].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function parentKeyForNodePath(path: string): string {
  return path ? path : ROOT_PARENT_KEY;
}

function orderFolderNodes(nodes: FolderNode[], parentKey: string, orderMap: FolderOrderMap): FolderNode[] {
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  const preferred = (orderMap[parentKey] ?? []).filter((p) => byPath.has(p));
  const remaining = sortNodes(nodes.filter((n) => !preferred.includes(n.path)));
  return [...preferred.map((p) => byPath.get(p)!), ...remaining];
}

function reorderPathsWithinParent(
  siblingPaths: string[],
  draggedPath: string,
  targetPath: string
): string[] {
  const from = siblingPaths.indexOf(draggedPath);
  const to = siblingPaths.indexOf(targetPath);
  if (from < 0 || to < 0 || from === to) return siblingPaths;
  const next = [...siblingPaths];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

const folderColorOptions = [
  { label: "Default", value: "default", bg: "bg-blue-500", text: "text-blue-500", border: "border-blue-500/20", hoverBorder: "group-hover:border-blue-500/40", lightBg: "bg-blue-500/10", fill: "fill-blue-500/40" },
  { label: "Emerald", value: "emerald", bg: "bg-emerald-500", text: "text-emerald-500", border: "border-emerald-500/20", hoverBorder: "group-hover:border-emerald-500/40", lightBg: "bg-emerald-500/10", fill: "fill-emerald-500/40" },
  { label: "Amber", value: "amber", bg: "bg-amber-500", text: "text-amber-500", border: "border-amber-500/20", hoverBorder: "group-hover:border-amber-500/40", lightBg: "bg-amber-500/10", fill: "fill-amber-500/40" },
  { label: "Rose", value: "rose", bg: "bg-rose-500", text: "text-rose-500", border: "border-rose-500/20", hoverBorder: "group-hover:border-rose-500/40", lightBg: "bg-rose-500/10", fill: "fill-rose-500/40" },
  { label: "Violet", value: "violet", bg: "bg-violet-500", text: "text-violet-500", border: "border-violet-500/20", hoverBorder: "group-hover:border-violet-500/40", lightBg: "bg-violet-500/10", fill: "fill-violet-500/40" },
  { label: "Slate", value: "slate", bg: "bg-slate-500", text: "text-slate-500", border: "border-slate-500/20", hoverBorder: "group-hover:border-slate-500/40", lightBg: "bg-slate-500/10", fill: "fill-slate-500/40" },
];

export interface CheckFolderSidebarProps {
  checks: Website[];
  selectedFolder: FolderKey;
  collapsedFolders: string[];
  onSelectFolder: (folder: FolderKey) => void;
  onToggleCollapse: (path: string) => void;
  onNewFolder?: () => void;
  isNano?: boolean;
  onSetFolder?: (id: string, folder: string | null) => void | Promise<void>;
  draggingCheckId?: string | null;
  draggingFolderPath?: string | null;
  onDragFolderStart?: (path: string) => void;
  onDragFolderEnd?: () => void;
  onFolderReorder?: (parentKey: string, newOrder: string[]) => void;
  onMobileTreeClose?: () => void;
  headerLabel?: string;
  allLabel?: string;
  sectionLabel?: string;
  mobile?: boolean;
}

export function CheckFolderSidebar({
  checks,
  selectedFolder,
  collapsedFolders,
  onSelectFolder,
  onToggleCollapse,
  onNewFolder,
  isNano = false,
  onSetFolder,
  draggingCheckId = null,
  draggingFolderPath = null,
  onDragFolderStart,
  onDragFolderEnd,
  onFolderReorder,
  onMobileTreeClose,
  headerLabel = "Navigation",
  allLabel = "All Checks",
  sectionLabel = "Folders",
  mobile = false,
}: CheckFolderSidebarProps) {
  const [customFolders] = useLocalStorage<string[]>("checks-folder-view-custom-folders-v1", []);
  const [folderOrderByParent] = useLocalStorage<FolderOrderMap>(
    "checks-folder-view-folder-order-v1",
    {}
  );
  const [folderColors] = useLocalStorage<Record<string, string>>("checks-folder-view-colors-v1", {});

  const normalizedCustomFolders = useMemo(() => {
    const set = new Set<string>();
    for (const f of customFolders) {
      const n = normalizeFolder(f);
      if (n) set.add(n);
    }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [customFolders]);

  const { root } = useMemo(
    () => buildFolderTree(checks, normalizedCustomFolders),
    [checks, normalizedCustomFolders]
  );

  const collapsedSet = useMemo(() => new Set(collapsedFolders), [collapsedFolders]);

  const getFolderTheme = useCallback((path: string, count: number) => {
    const custom = folderColors[path];
    const color = (custom && custom !== "default") ? custom : (count === 0 ? "slate" : "blue");

    const theme = folderColorOptions.find(o => o.value === color) || folderColorOptions[0]!;

    if (!custom || custom === "default") {
      if (count === 0) {
        return {
          ...folderColorOptions.find(o => o.value === "slate")!,
          text: "text-muted-foreground/60",
          fill: "fill-muted-foreground/10",
          lightBg: "bg-slate-500/5",
          border: "border-slate-500/10",
          hoverBorder: "group-hover:border-slate-500/30"
        };
      }
    }

    return theme;
  }, [folderColors]);

  const select = useCallback((key: FolderKey) => {
    onSelectFolder(key);
    onMobileTreeClose?.();
  }, [onSelectFolder, onMobileTreeClose]);

  const renderTree = useCallback(
    (node: FolderNode) => {
      const parentKey = parentKeyForNodePath(node.path);
      const children = orderFolderNodes([...node.children.values()], parentKey, folderOrderByParent);
      const siblingPaths = children.map((c) => c.path);

      return children.map((child) => {
        const depth = Math.max(0, getFolderDepth(child.path) - 1);
        const isCollapsed = collapsedSet.has(child.path);
        const isSelected = selectedFolder === child.path;
        const hasChildren = child.children.size > 0;
        const totalCount = child.checkCount;
        const childParentKey = getParentPath(child.path) ?? ROOT_PARENT_KEY;

        return (
          <div key={child.path} className="min-w-0">
            <div
              className={cn(
                "group flex items-center gap-2 rounded-lg px-2 py-1 text-sm font-medium transition-all cursor-pointer select-none",
                isSelected
                  ? "bg-primary/10 text-primary shadow-sm"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                draggingFolderPath === child.path && "opacity-50",
                draggingCheckId && "ring-2 ring-primary ring-dashed"
              )}
              style={{ paddingLeft: 8 + depth * 12 }}
              draggable={!!onDragFolderStart}
              onDragStart={(e) => {
                if (onDragFolderStart) {
                  e.dataTransfer.setData("text/plain", child.path);
                  e.dataTransfer.effectAllowed = "move";
                  onDragFolderStart(child.path);
                }
              }}
              onDragEnd={() => {
                if (onDragFolderEnd) onDragFolderEnd();
              }}
              onDragOver={(e) => {
                // Handle folder reordering
                if (draggingFolderPath && onFolderReorder) {
                  if (draggingFolderPath === child.path) return;
                  const draggingParentKey = getParentPath(draggingFolderPath) ?? ROOT_PARENT_KEY;
                  if (draggingParentKey !== childParentKey) return;
                  e.preventDefault();
                  return;
                }
                // Handle check drop
                if (draggingCheckId && isNano && onSetFolder) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={async (e) => {
                e.preventDefault();

                // Handle folder reordering
                if (draggingFolderPath && onFolderReorder) {
                  const draggingParentKey = getParentPath(draggingFolderPath) ?? ROOT_PARENT_KEY;
                  if (draggingParentKey !== childParentKey) return;

                  const nextOrder = reorderPathsWithinParent(siblingPaths, draggingFolderPath, child.path);
                  onFolderReorder(childParentKey, nextOrder);
                  return;
                }

                // Handle check drop
                if (draggingCheckId && isNano && onSetFolder) {
                  await onSetFolder(draggingCheckId, child.path);
                  toast.success("Moved to folder");
                }
              }}
              onClick={() => select(child.path)}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className="size-5 shrink-0 inline-flex items-center justify-center rounded hover:bg-muted/80 transition-transform"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleCollapse(child.path);
                  }}
                >
                  <ChevronRight className={cn("size-3 transition-transform", !isCollapsed && "rotate-90")} />
                </button>
              ) : (
                <span className="size-5 shrink-0" />
              )}
              <Folder className={cn(
                "size-4 shrink-0 transition-colors",
                isSelected
                  ? "text-primary fill-primary/20"
                  : cn(getFolderTheme(child.path, totalCount).text, getFolderTheme(child.path, totalCount).fill)
              )} />
              <span className="truncate flex-1">{child.name}</span>
              {totalCount > 0 && (
                <span className="text-xs font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground group-hover:bg-muted/80">
                  {totalCount}
                </span>
              )}
            </div>

            {hasChildren && !isCollapsed && (
              <div className="mt-0.5">{renderTree(child)}</div>
            )}
          </div>
        );
      });
    },
    [collapsedSet, folderOrderByParent, selectedFolder, select, onToggleCollapse, draggingCheckId, draggingFolderPath, isNano, onSetFolder, onFolderReorder, getFolderTheme]
  );

  return (
    <aside className={cn(
      mobile ? "flex" : "hidden lg:flex",
      "flex-col border-r border-border/50 bg-muted/20 backdrop-blur-xl"
    )}>
      <div className="p-5 flex items-center justify-between border-b border-border/10">
        <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-[0.2em] opacity-70">{headerLabel}</span>
        {onNewFolder ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={onNewFolder}
          >
            <Plus className="size-3" />
          </Button>
        ) : (
          <div className="size-6" />
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="px-2 py-2 space-y-0.5">
          {/* Root "Checks" link */}
          <div
            className={cn(
              "group flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all cursor-pointer select-none",
              selectedFolder === "__all__"
                ? "bg-primary/10 text-primary shadow-sm"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              draggingCheckId && "ring-2 ring-primary ring-dashed"
            )}
            onClick={() => select("__all__")}
            onDragOver={(e) => {
              if (draggingCheckId && isNano && onSetFolder) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={async (e) => {
              if (draggingCheckId && isNano && onSetFolder) {
                e.preventDefault();
                await onSetFolder(draggingCheckId, null);
                toast.success("Moved to root");
              }
            }}
          >
            <div className={cn(
              "p-1 rounded-md transition-colors",
              selectedFolder === "__all__" ? "bg-primary/20" : "bg-muted"
            )}>
              <Globe className="size-3.5" />
            </div>
            <span className="truncate flex-1">{allLabel}</span>
          </div>

          <div className="mt-3 pt-3 border-t border-border/50">
            <div className="flex items-center justify-between px-3 mb-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{sectionLabel}</span>
              {isNano && (
                <span className="text-[10px] text-muted-foreground/40 font-medium hidden lg:block italic">Drag & drop supported</span>
              )}
            </div>
            {renderTree(root)}
          </div>
        </div>
      </ScrollArea>
    </aside>
  );
}

