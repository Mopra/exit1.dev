import React, { useCallback, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ConfirmationModal,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  ScrollArea,
  StatusBadge,
} from "../ui";
import type { Website } from "../../types";
import { cn } from "../../lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { toast } from "sonner";
import {
  ChevronRight,
  ExternalLink,
  Folder,
  FolderOpen,
  MoreVertical,
  Pencil,
  Play,
  Pause,
  Plus,
  Trash2,
  Loader2,
} from "lucide-react";

type FolderKey = "__all__" | string;
type FolderOrderMap = Record<string, string[]>;

const ROOT_PARENT_KEY = "__root__";

function normalizeFolder(folder?: string | null): string | null {
  const raw = (folder ?? "").trim();
  if (!raw) return null;
  // Normalize separators and whitespace, avoid leading/trailing slashes.
  // NOTE: `String.prototype.replaceAll` requires ES2021 lib; keep this ES2020-compatible.
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

function folderHasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

function replaceFolderPrefix(path: string, fromPrefix: string, toPrefix: string): string {
  if (path === fromPrefix) return toPrefix;
  if (path.startsWith(fromPrefix + "/")) return toPrefix + path.slice(fromPrefix.length);
  return path;
}

function transformOnDelete(path: string, target: string): string | null {
  if (!folderHasPrefix(path, target)) return path;
  if (path === target) return null;

  const parent = getParentPath(target);
  const remainder = path.slice(target.length + 1);
  if (!remainder) return parent;
  return parent ? `${parent}/${remainder}` : remainder;
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

  // Fill checkCount for nodes: checks directly in that folder (not recursive).
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
  // Root node uses empty path -> map it to a stable key.
  return path ? path : ROOT_PARENT_KEY;
}

function orderFolderNodes(nodes: FolderNode[], parentKey: string, orderMap: FolderOrderMap): FolderNode[] {
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  const preferred = (orderMap[parentKey] ?? []).filter((p) => byPath.has(p));
  const remaining = sortNodes(nodes.filter((n) => !preferred.includes(n.path)));
  return [...preferred.map((p) => byPath.get(p)!), ...remaining];
}

function orderFolderItems<T extends { path: string; name: string }>(
  items: T[],
  parentKey: string,
  orderMap: FolderOrderMap
): T[] {
  const byPath = new Map(items.map((i) => [i.path, i]));
  const preferred = (orderMap[parentKey] ?? []).filter((p) => byPath.has(p));
  const remaining = [...items]
    .filter((i) => !preferred.includes(i.path))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
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

function getChildFoldersForPath(
  checks: Website[],
  currentPath: FolderKey,
  customFolders: string[]
): Array<{ path: string; name: string; count: number }> {
  const map = new Map<string, { path: string; name: string; count: number }>();
  // Always treat `prefix` as a string for downstream helpers.
  const prefix = currentPath === "__all__" ? "" : (normalizeFolder(currentPath) ?? "");

  const considerFolderPath = (folderPath: string, countDelta: number) => {
    const folder = normalizeFolder(folderPath);
    if (!folder) return;
    const parts = splitFolderPath(folder);
    if (prefix === "") {
      if (parts.length >= 1) {
        const p = parts[0]!;
        map.set(p, { path: p, name: p, count: (map.get(p)?.count ?? 0) + countDelta });
      }
      return;
    }
    const prefixParts = splitFolderPath(prefix);
    const isInPrefix = folder === prefix || folder.startsWith(prefix + "/");
    if (!isInPrefix) return;
    if (parts.length <= prefixParts.length) return;
    const nextPart = parts[prefixParts.length]!;
    const childPath = joinPath([...prefixParts, nextPart]);
    map.set(childPath, { path: childPath, name: nextPart, count: (map.get(childPath)?.count ?? 0) + countDelta });
  };

  for (const c of checks) {
    const folder = normalizeFolder(c.folder);
    if (!folder) continue;
    considerFolderPath(folder, 1);
  }
  for (const f of customFolders) {
    considerFolderPath(f, 0);
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function getChecksInFolder(checks: Website[], currentPath: FolderKey): Website[] {
  if (currentPath === "__all__") return checks;
  const normalized = normalizeFolder(currentPath);
  if (!normalized) return [];
  return checks.filter((c) => normalizeFolder(c.folder) === normalized);
}

export interface CheckFolderViewProps {
  checks: Website[];
  onDelete: (id: string) => void;
  onCheckNow: (id: string) => void;
  onToggleStatus: (id: string, disabled: boolean) => void;
  onEdit: (check: Website) => void;
  isNano?: boolean;
  onSetFolder?: (id: string, folder: string | null) => void | Promise<void>;
  onRenameFolder?: (fromFolder: string, toFolder: string) => void | Promise<void>;
  onDeleteFolder?: (folder: string) => void | Promise<void>;
  manualChecksInProgress?: string[];
}

export default function CheckFolderView({
  checks,
  onDelete,
  onCheckNow,
  onToggleStatus,
  onEdit,
  isNano = false,
  onSetFolder,
  onRenameFolder,
  onDeleteFolder,
  manualChecksInProgress = [],
}: CheckFolderViewProps) {
  const [customFolders, setCustomFolders] = useLocalStorage<string[]>("checks-folder-view-custom-folders-v1", []);
  const [folderOrderByParent, setFolderOrderByParent] = useLocalStorage<FolderOrderMap>(
    "checks-folder-view-folder-order-v1",
    {}
  );
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

  const [deletingCheck, setDeletingCheck] = useState<Website | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderPath, setNewFolderPath] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [draggingFolderPath, setDraggingFolderPath] = useState<string | null>(null);
  const [draggingCheckId, setDraggingCheckId] = useState<string | null>(null);
  const [renameFolderOpen, setRenameFolderOpen] = useState(false);
  const [renameFolderValue, setRenameFolderValue] = useState("");
  const [renameFolderError, setRenameFolderError] = useState<string | null>(null);
  const [deleteFolderConfirmOpen, setDeleteFolderConfirmOpen] = useState(false);
  const [folderMutating, setFolderMutating] = useState(false);

  const [selectedFolder, setSelectedFolder] = useLocalStorage<FolderKey>("checks-folder-view-selected-v1", "__all__");
  const [collapsed, setCollapsed] = useLocalStorage<string[]>("checks-folder-view-collapsed-v1", []);
  const collapsedSet = useMemo(() => new Set(collapsed), [collapsed]);

  const isManuallyChecking = useCallback(
    (checkId: string) => manualChecksInProgress.includes(checkId),
    [manualChecksInProgress]
  );

  const folderOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of checks) {
      const f = normalizeFolder(c.folder);
      if (f) set.add(f);
    }
    for (const f of normalizedCustomFolders) set.add(f);
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [checks, normalizedCustomFolders]);

  const toggleCollapsed = useCallback(
    (path: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return [...next];
      });
    },
    [setCollapsed]
  );

  const select = useCallback((key: FolderKey) => setSelectedFolder(key), [setSelectedFolder]);

  const childFoldersUnordered = useMemo(
    () => getChildFoldersForPath(checks, selectedFolder, normalizedCustomFolders),
    [checks, selectedFolder, normalizedCustomFolders]
  );
  const checksInFolder = useMemo(() => getChecksInFolder(checks, selectedFolder), [checks, selectedFolder]);
  const currentFolderParentKey = useMemo(() => {
    if (selectedFolder === "__all__") return ROOT_PARENT_KEY;
    return normalizeFolder(selectedFolder) ?? ROOT_PARENT_KEY;
  }, [selectedFolder]);
  const childFolders = useMemo(() => {
    return orderFolderItems(childFoldersUnordered, currentFolderParentKey, folderOrderByParent);
  }, [childFoldersUnordered, currentFolderParentKey, folderOrderByParent]);

  const breadcrumbParts = useMemo(() => {
    if (selectedFolder === "__all__") return [{ label: "All checks", key: "__all__" as FolderKey }];
    const normalized = normalizeFolder(selectedFolder);
    if (!normalized) return [{ label: "All checks", key: "__all__" as FolderKey }];
    const parts = splitFolderPath(normalized);
    const crumbs: Array<{ label: string; key: FolderKey }> = [{ label: "All checks", key: "__all__" }];
    let cursor: string[] = [];
    for (const p of parts) {
      cursor.push(p);
      crumbs.push({ label: p, key: joinPath(cursor) });
    }
    return crumbs;
  }, [selectedFolder]);

  const goUp = useCallback(() => {
    if (selectedFolder === "__all__") return;
    const normalized = normalizeFolder(selectedFolder);
    if (!normalized) return select("__all__");
    const parent = getParentPath(normalized);
    if (!parent) return select("__all__");
    select(parent);
  }, [select, selectedFolder]);

  const selectedFolderPath = useMemo(() => {
    if (selectedFolder === "__all__") return null;
    return normalizeFolder(selectedFolder);
  }, [selectedFolder]);

  const affectedCheckCount = useMemo(() => {
    if (!selectedFolderPath) return 0;
    return checks.filter((c) => {
      const f = normalizeFolder(c.folder);
      if (!f) return false;
      return folderHasPrefix(f, selectedFolderPath);
    }).length;
  }, [checks, selectedFolderPath]);

  const renderTree = useCallback(
    (node: FolderNode) => {
      const parentKey = parentKeyForNodePath(node.path);
      const children = orderFolderNodes([...node.children.values()], parentKey, folderOrderByParent);
      const siblingPaths = children.map((c) => c.path);

      return children.map((child) => {
        // Make top-level folders align with "All checks" (root-level),
        // while keeping nested folders indented normally.
        const depth = Math.max(0, getFolderDepth(child.path) - 1);
        const isCollapsed = collapsedSet.has(child.path);
        const isSelected = selectedFolder === child.path;
        const hasChildren = child.children.size > 0;
        const totalCount = child.checkCount + (hasChildren ? 0 : 0);
        const childParentKey = getParentPath(child.path) ?? ROOT_PARENT_KEY;

        return (
          <div key={child.path} className="min-w-0">
            <div
              className={cn(
                "flex items-center gap-1.5 sm:gap-1 rounded-md px-2 sm:px-1 py-1.5 sm:py-0.5 text-sm min-w-0 hover:bg-muted/60 cursor-pointer touch-manipulation",
                isSelected && "bg-muted",
                draggingCheckId && "bg-primary/10 border-2 border-primary border-dashed"
              )}
              style={{ paddingLeft: 8 + depth * 12 }}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", child.path);
                e.dataTransfer.effectAllowed = "move";
                setDraggingFolderPath(child.path);
              }}
              onDragEnd={() => setDraggingFolderPath(null)}
              onDragOver={(e) => {
                // Handle folder reordering
                if (draggingFolderPath) {
                  if (draggingFolderPath === child.path) return;
                  if (draggingFolderPath === "__all__" || child.path === "__all__") return;
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
                if (draggingFolderPath) {
                  if (draggingFolderPath === "__all__" || child.path === "__all__") return;
                  const draggingParentKey = getParentPath(draggingFolderPath) ?? ROOT_PARENT_KEY;
                  if (draggingParentKey !== childParentKey) return;

                  const nextOrder = reorderPathsWithinParent(siblingPaths, draggingFolderPath, child.path);
                  setFolderOrderByParent((prev) => ({ ...prev, [childParentKey]: nextOrder }));
                  return;
                }
                
                // Handle check drop
                if (draggingCheckId && isNano && onSetFolder) {
                  await onSetFolder(draggingCheckId, child.path);
                  setDraggingCheckId(null);
                  toast.success("Check moved to folder");
                }
              }}
              onClick={() => {
                select(child.path);
                setMobileTreeOpen(false);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") select(child.path);
              }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className="size-6 sm:size-6 shrink-0 inline-flex items-center justify-center rounded hover:bg-muted cursor-pointer touch-manipulation"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapsed(child.path);
                  }}
                  aria-label={isCollapsed ? "Expand folder" : "Collapse folder"}
                >
                  <ChevronRight className={cn("size-4 transition-transform", !isCollapsed && "rotate-90")} />
                </button>
              ) : (
                <span className="size-6 shrink-0" />
              )}
              {isSelected ? <FolderOpen className="size-4 sm:size-4 text-primary shrink-0" /> : <Folder className="size-4 sm:size-4 shrink-0" />}
              <span className="truncate flex-1">{child.name}</span>
              {totalCount > 0 && (
                <Badge variant="secondary" className="shrink-0 text-xs">
                  {totalCount}
                </Badge>
              )}
            </div>

            {hasChildren && !isCollapsed && (
              <div className="min-w-0">{renderTree(child)}</div>
            )}
          </div>
        );
      });
    },
    [collapsedSet, folderOrderByParent, selectedFolder, select, setFolderOrderByParent, toggleCollapsed, draggingFolderPath, draggingCheckId, isNano, onSetFolder]
  );

  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);

  return (
    <div className="h-full grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-2 sm:gap-3 min-w-0 max-w-full overflow-x-hidden items-start">
      {/* Folder tree */}
      <Card className="min-w-0 hidden lg:flex flex-col max-w-full overflow-hidden">
        <CardHeader className="py-2 px-3 sm:px-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Folders</div>
            <Button
              size="sm"
              variant="secondary"
              className="h-7 px-2 cursor-pointer touch-manipulation"
              onClick={() => {
                setNewFolderError(null);
                setNewFolderPath("");
                setNewFolderOpen(true);
              }}
            >
              <Plus className="size-4" />
              <span className="hidden sm:inline">New</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0 px-2 sm:px-3 pb-4 min-w-0">
          <ScrollArea className="pr-2">
            <div className="space-y-0.5 sm:space-y-0 min-w-0 pt-2">
              {/* "All checks" as a first-class tree row (same structure as folders) */}
              <div
                className={cn(
                  "flex items-center gap-1.5 sm:gap-1 rounded-md px-2 sm:px-1 py-1.5 sm:py-0.5 text-sm min-w-0 hover:bg-muted/60 cursor-pointer touch-manipulation",
                  selectedFolder === "__all__" && "bg-muted",
                  draggingCheckId && "bg-primary/10 border-2 border-primary border-dashed"
                )}
                style={{ paddingLeft: 8 }}
                onClick={() => {
                  select("__all__");
                  setMobileTreeOpen(false);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") select("__all__");
                }}
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
                    setDraggingCheckId(null);
                    toast.success("Check moved to unsorted");
                  }
                }}
              >
                <span className="size-6 shrink-0" />
                {selectedFolder === "__all__" ? (
                  <FolderOpen className="size-4 text-primary shrink-0" />
                ) : (
                  <Folder className="size-4 shrink-0" />
                )}
                <span className="truncate flex-1">All checks</span>
              </div>

              <div>{renderTree(root)}</div>
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Folder contents */}
      <div className="min-w-0 max-w-full overflow-x-hidden flex flex-col h-full">
        {/* Mobile folder tree toggle */}
        <div className="lg:hidden mb-2 w-full max-w-full">
          <Button
            variant="outline"
            size="sm"
            className="w-full max-w-full cursor-pointer touch-manipulation"
            onClick={() => setMobileTreeOpen(!mobileTreeOpen)}
          >
            <Folder className="size-4 mr-2 shrink-0" />
            <span className="flex-1 text-left truncate min-w-0">
              {selectedFolder === "__all__" ? "All checks" : breadcrumbParts[breadcrumbParts.length - 1]?.label || "Select folder"}
            </span>
            <ChevronRight className={cn("size-4 transition-transform shrink-0", mobileTreeOpen && "rotate-90")} />
          </Button>
        </div>

        {/* Mobile folder tree overlay */}
        {mobileTreeOpen && (
          <div className="lg:hidden fixed inset-0 z-50 bg-background/80 backdrop-blur-sm overflow-hidden" onClick={() => setMobileTreeOpen(false)}>
            <Card className="absolute top-0 left-0 h-full w-[280px] max-w-[85vw] shadow-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <CardHeader className="py-3 px-4 border-b">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium">Folders</div>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 px-2 cursor-pointer touch-manipulation"
                  onClick={() => {
                    setNewFolderError(null);
                    setNewFolderPath("");
                    setNewFolderOpen(true);
                  }}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-3 px-3 pb-4 min-w-0 overflow-y-auto h-[calc(100%-4rem)]">
              <div className="space-y-0.5 min-w-0 pt-2">
                <div
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm min-w-0 hover:bg-muted/60 cursor-pointer touch-manipulation",
                    selectedFolder === "__all__" && "bg-muted",
                    draggingCheckId && "bg-primary/10 border-2 border-primary border-dashed"
                  )}
                  style={{ paddingLeft: 8 }}
                  onClick={() => {
                    select("__all__");
                    setMobileTreeOpen(false);
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") select("__all__");
                  }}
                >
                  <span className="size-6 shrink-0" />
                  {selectedFolder === "__all__" ? (
                    <FolderOpen className="size-4 text-primary shrink-0" />
                  ) : (
                    <Folder className="size-4 shrink-0" />
                  )}
                  <span className="truncate flex-1">All checks</span>
                </div>
                <div>{renderTree(root)}</div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card className="h-full min-w-0 max-w-full flex flex-col overflow-hidden">
        <CardHeader className="py-2 px-2 sm:px-3 md:px-4 min-w-0 max-w-full">
          <div className="flex items-center justify-between gap-1.5 sm:gap-2 min-w-0 max-w-full">
            <div className="flex items-center gap-1 sm:gap-1.5 md:gap-2 min-w-0 flex-1 overflow-hidden">
              <div className="flex items-center gap-0.5 sm:gap-1 text-xs sm:text-sm min-w-0 flex-wrap overflow-hidden">
                {breadcrumbParts.map((c, idx) => (
                  <React.Fragment key={`${c.key}-${idx}`}>
                    {idx > 0 && <span className="text-muted-foreground px-0.5 shrink-0">/</span>}
                    <button
                      type="button"
                      className={cn(
                        "truncate cursor-pointer hover:underline touch-manipulation min-w-0",
                        idx === breadcrumbParts.length - 1 ? "font-medium hover:no-underline max-w-[100px] sm:max-w-[150px] md:max-w-none" : "max-w-[80px] sm:max-w-[120px] md:max-w-none"
                      )}
                      onClick={() => select(c.key)}
                      aria-label={`Go to ${c.label}`}
                    >
                      {c.label}
                    </button>
                  </React.Fragment>
                ))}
              </div>
              {selectedFolder !== "__all__" && (
                <Button size="sm" variant="ghost" className="h-7 px-1.5 sm:px-2 cursor-pointer touch-manipulation shrink-0" onClick={goUp}>
                  <span className="hidden sm:inline">Up</span>
                  <ChevronRight className="size-4 sm:hidden rotate-[-90deg]" />
                </Button>
              )}
            </div>
            <div className="flex items-center gap-1 sm:gap-1.5 md:gap-2 shrink-0">
              <div className="text-xs text-muted-foreground hidden sm:inline whitespace-nowrap">{checksInFolder.length} items</div>
              {selectedFolderPath && isNano && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 cursor-pointer touch-manipulation"
                      aria-label="Folder actions"
                      disabled={folderMutating}
                    >
                      {folderMutating ? <Loader2 className="size-4 animate-spin" /> : <MoreVertical className="size-4" />}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onClick={() => {
                        setRenameFolderError(null);
                        setRenameFolderValue(selectedFolderPath);
                        setRenameFolderOpen(true);
                      }}
                    >
                      <Pencil className="size-4" />
                      <span className="ml-2">Rename</span>
                    </DropdownMenuItem>

                    <DropdownMenuItem
                      className="cursor-pointer"
                      onClick={() => {
                        setNewFolderError(null);
                        setNewFolderPath(`${selectedFolderPath}/`);
                        setNewFolderOpen(true);
                      }}
                    >
                      <Plus className="size-4" />
                      <span className="ml-2">New subfolder</span>
                    </DropdownMenuItem>

                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="cursor-pointer text-destructive focus:text-destructive"
                      onClick={() => setDeleteFolderConfirmOpen(true)}
                    >
                      <Trash2 className="size-4" />
                      <span className="ml-2">Delete</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-0 px-2 sm:px-3 pb-3 min-w-0 max-w-full flex-1 overflow-hidden">
          <ScrollArea className="h-full pr-1 sm:pr-2 overflow-x-hidden">
            <div className="space-y-3 min-w-0 max-w-full">
              {childFolders.length > 0 && (
                <div className="min-w-0 max-w-full">
                  <div className="text-xs font-medium text-muted-foreground mb-2 px-1">Folders</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2 min-w-0 max-w-full">
                    {childFolders.map((f) => (
                      <button
                        key={f.path}
                        type="button"
                        className="text-left cursor-pointer w-full min-w-0 max-w-full"
                        onClick={() => select(f.path)}
                      >
                        <Card
                          className={cn(
                            "hover:bg-muted/30 transition-colors touch-manipulation w-full min-w-0 max-w-full overflow-hidden",
                            draggingFolderPath === f.path && "opacity-60",
                            draggingCheckId && "bg-primary/10 border-2 border-primary border-dashed"
                          )}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData("text/plain", f.path);
                            e.dataTransfer.effectAllowed = "move";
                            setDraggingFolderPath(f.path);
                          }}
                          onDragEnd={() => setDraggingFolderPath(null)}
                          onDragOver={(e) => {
                            // Handle folder reordering
                            if (draggingFolderPath) {
                              if (draggingFolderPath === f.path) return;
                              // Grid only supports sibling reordering within the current folder.
                              const draggingParentKey = getParentPath(draggingFolderPath) ?? ROOT_PARENT_KEY;
                              if (draggingParentKey !== currentFolderParentKey) return;
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
                            if (draggingFolderPath) {
                              const draggingParentKey = getParentPath(draggingFolderPath) ?? ROOT_PARENT_KEY;
                              if (draggingParentKey !== currentFolderParentKey) return;
                              const siblingPaths = childFolders.map((x) => x.path);
                              const nextOrder = reorderPathsWithinParent(siblingPaths, draggingFolderPath, f.path);
                              setFolderOrderByParent((prev) => ({ ...prev, [currentFolderParentKey]: nextOrder }));
                              return;
                            }
                            
                            // Handle check drop
                            if (draggingCheckId && isNano && onSetFolder) {
                              await onSetFolder(draggingCheckId, f.path);
                              setDraggingCheckId(null);
                              toast.success("Check moved to folder");
                            }
                          }}
                        >
                          <CardContent className="p-2 sm:p-3 flex items-center gap-2 sm:gap-3 min-w-0 max-w-full">
                            <Folder className="size-4 sm:size-5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1 overflow-hidden">
                              <div className="text-sm font-medium truncate">{f.name}</div>
                              <div className="text-xs text-muted-foreground truncate">{f.count} checks</div>
                            </div>
                            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                          </CardContent>
                        </Card>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="min-w-0 max-w-full">
                <div className="text-xs font-medium text-muted-foreground mb-2 px-1">Checks</div>
                {checksInFolder.length === 0 ? (
                  <div className="text-sm text-muted-foreground px-1">No checks in this folder.</div>
                ) : (
                  <div className="space-y-2 min-w-0 max-w-full">
                    {checksInFolder.map((check) => (
                      <Card 
                        key={check.id} 
                        className={cn(
                          "hover:bg-muted/30 transition-colors cursor-pointer touch-manipulation w-full min-w-0 max-w-full overflow-hidden",
                          draggingCheckId === check.id && "opacity-50"
                        )}
                        draggable={isNano && !!onSetFolder}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", check.id);
                          e.dataTransfer.effectAllowed = "move";
                          setDraggingCheckId(check.id);
                        }}
                        onDragEnd={() => setDraggingCheckId(null)}
                      >
                        <CardContent className="p-2 sm:p-3 flex items-center gap-2 sm:gap-3 min-w-0 max-w-full">
                          <div className="shrink-0">
                            <StatusBadge status={check.status ?? "unknown"} />
                          </div>

                          <div
                            className="min-w-0 flex-1 cursor-pointer touch-manipulation overflow-hidden"
                            onClick={() => onEdit(check)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") onEdit(check);
                            }}
                          >
                            <div className="text-sm font-medium truncate">{check.name}</div>
                            <div className="text-xs text-muted-foreground truncate">{check.url}</div>
                          </div>

                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8 cursor-pointer touch-manipulation shrink-0"
                                aria-label="More actions"
                              >
                                <MoreVertical className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() => {
                                  if (!check.disabled && !isManuallyChecking(check.id)) onCheckNow(check.id);
                                }}
                                disabled={Boolean(check.disabled) || isManuallyChecking(check.id)}
                              >
                                {isManuallyChecking(check.id) ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <Play className="size-4" />
                                )}
                                <span className="ml-2">{isManuallyChecking(check.id) ? "Checking..." : "Check now"}</span>
                              </DropdownMenuItem>

                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() => onToggleStatus(check.id, !check.disabled)}
                              >
                                {check.disabled ? <Play className="size-4" /> : <Pause className="size-4" />}
                                <span className="ml-2">{check.disabled ? "Enable" : "Disable"}</span>
                              </DropdownMenuItem>

                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() => onEdit(check)}
                              >
                                <Pencil className="size-4" />
                                <span className="ml-2">Edit</span>
                              </DropdownMenuItem>

                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() => window.open(check.url, "_blank")}
                              >
                                <ExternalLink className="size-4" />
                                <span className="ml-2">Open URL</span>
                              </DropdownMenuItem>

                              {isNano && onSetFolder && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuSub>
                                    <DropdownMenuSubTrigger className="cursor-pointer">
                                      <Folder className="size-4" />
                                      <span className="ml-2">Move to folder</span>
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent>
                                      <DropdownMenuItem
                                        className="cursor-pointer"
                                        onClick={() => onSetFolder(check.id, null)}
                                      >
                                        No folder
                                      </DropdownMenuItem>
                                      {folderOptions.map((f) => (
                                        <DropdownMenuItem
                                          key={f}
                                          className="cursor-pointer"
                                          onClick={() => onSetFolder(check.id, f)}
                                        >
                                          <span className="truncate max-w-[240px]">{f}</span>
                                        </DropdownMenuItem>
                                      ))}
                                    </DropdownMenuSubContent>
                                  </DropdownMenuSub>
                                </>
                              )}

                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="cursor-pointer text-destructive focus:text-destructive"
                                onClick={() => setDeletingCheck(check)}
                              >
                                <Trash2 className="size-4" />
                                <span className="ml-2">Delete</span>
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
      </div>

      <ConfirmationModal
        isOpen={Boolean(deletingCheck)}
        onClose={() => setDeletingCheck(null)}
        onConfirm={() => {
          if (!deletingCheck) return;
          onDelete(deletingCheck.id);
          setDeletingCheck(null);
        }}
        title="Delete check"
        message={deletingCheck ? `This will permanently delete “${deletingCheck.name}”.` : "This will permanently delete this check."}
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />

      <ConfirmationModal
        isOpen={deleteFolderConfirmOpen}
        onClose={() => setDeleteFolderConfirmOpen(false)}
        onConfirm={async () => {
          if (!selectedFolderPath) return;
          setFolderMutating(true);
          try {
            if (onDeleteFolder) await onDeleteFolder(selectedFolderPath);

            // Update local empty folders + ordering best-effort
            setCustomFolders((prev) => {
              const next = new Set<string>();
              for (const raw of prev) {
                const n = normalizeFolder(raw);
                if (!n) continue;
                const transformed = transformOnDelete(n, selectedFolderPath);
                if (!transformed) continue;
                next.add(transformed);
              }
              return [...next].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
            });

            setFolderOrderByParent((prev) => {
              const next: FolderOrderMap = {};
              for (const [parentKey, arr] of Object.entries(prev)) {
                const normalizedParent = parentKey === ROOT_PARENT_KEY ? ROOT_PARENT_KEY : (normalizeFolder(parentKey) ?? ROOT_PARENT_KEY);
                const transformedParent =
                  normalizedParent === ROOT_PARENT_KEY ? ROOT_PARENT_KEY : (transformOnDelete(normalizedParent, selectedFolderPath) ?? ROOT_PARENT_KEY);
                const transformedChildren: string[] = [];
                for (const childPath of arr) {
                  const normalizedChild = normalizeFolder(childPath);
                  if (!normalizedChild) continue;
                  const transformedChild = transformOnDelete(normalizedChild, selectedFolderPath);
                  if (!transformedChild) continue;
                  transformedChildren.push(transformedChild);
                }
                if (!next[transformedParent]) next[transformedParent] = [];
                for (const p of transformedChildren) {
                  if (!next[transformedParent]!.includes(p)) next[transformedParent]!.push(p);
                }
              }
              // Remove a now-stale key for the deleted folder itself (if present)
              delete next[selectedFolderPath];
              return next;
            });

            const parent = getParentPath(selectedFolderPath);
            setSelectedFolder(parent ?? "__all__");
            setDeleteFolderConfirmOpen(false);
            toast.success("Folder deleted");
          } catch (err: any) {
            toast.error("Could not delete folder", { description: err?.message ?? "Unknown error" });
          } finally {
            setFolderMutating(false);
          }
        }}
        title="Delete folder"
        message={
          selectedFolderPath
            ? `Delete “${selectedFolderPath}”? Checks inside will be moved up one level. (${affectedCheckCount} checks affected)`
            : "Delete this folder?"
        }
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />

      <Dialog open={renameFolderOpen} onOpenChange={setRenameFolderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename folder</DialogTitle>
            <DialogDescription>This renames the folder and updates checks inside it.</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="rename-folder-path">Folder path</Label>
            <Input
              id="rename-folder-path"
              value={renameFolderValue}
              onChange={(e) => {
                setRenameFolderValue(e.target.value);
                setRenameFolderError(null);
              }}
              placeholder="e.g. prod/api"
            />
            {renameFolderError && <div className="text-sm text-destructive">{renameFolderError}</div>}
          </div>

          <DialogFooter>
            <Button variant="outline" className="cursor-pointer" onClick={() => setRenameFolderOpen(false)}>
              Cancel
            </Button>
            <Button
              className="cursor-pointer"
              disabled={folderMutating}
              onClick={async () => {
                if (!selectedFolderPath) return;
                const nextPath = normalizeFolder(renameFolderValue);
                if (!nextPath) {
                  setRenameFolderError("Enter a folder name.");
                  return;
                }
                if (nextPath === selectedFolderPath) {
                  setRenameFolderOpen(false);
                  return;
                }
                if (folderHasPrefix(nextPath, selectedFolderPath)) {
                  setRenameFolderError("Folder can’t be moved inside itself.");
                  return;
                }
                if (folderOptions.includes(nextPath)) {
                  setRenameFolderError("That folder already exists.");
                  return;
                }

                setFolderMutating(true);
                try {
                  if (onRenameFolder) await onRenameFolder(selectedFolderPath, nextPath);

                  setCustomFolders((prev) => {
                    const next = new Set<string>();
                    for (const raw of prev) {
                      const n = normalizeFolder(raw);
                      if (!n) continue;
                      const transformed = folderHasPrefix(n, selectedFolderPath) ? replaceFolderPrefix(n, selectedFolderPath, nextPath) : n;
                      if (!transformed) continue;
                      next.add(transformed);
                    }
                    // Ensure the renamed folder exists even if it was empty before
                    next.add(nextPath);
                    return [...next].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
                  });

                  setFolderOrderByParent((prev) => {
                    const next: FolderOrderMap = {};
                    for (const [parentKey, arr] of Object.entries(prev)) {
                      const normalizedParent = parentKey === ROOT_PARENT_KEY ? ROOT_PARENT_KEY : (normalizeFolder(parentKey) ?? ROOT_PARENT_KEY);
                      const transformedParent =
                        normalizedParent === ROOT_PARENT_KEY
                          ? ROOT_PARENT_KEY
                          : (folderHasPrefix(normalizedParent, selectedFolderPath)
                              ? replaceFolderPrefix(normalizedParent, selectedFolderPath, nextPath)
                              : normalizedParent);

                      const transformedChildren: string[] = [];
                      for (const childPath of arr) {
                        const normalizedChild = normalizeFolder(childPath);
                        if (!normalizedChild) continue;
                        const transformedChild = folderHasPrefix(normalizedChild, selectedFolderPath)
                          ? replaceFolderPrefix(normalizedChild, selectedFolderPath, nextPath)
                          : normalizedChild;
                        transformedChildren.push(transformedChild);
                      }

                      if (!next[transformedParent]) next[transformedParent] = [];
                      for (const p of transformedChildren) {
                        if (!next[transformedParent]!.includes(p)) next[transformedParent]!.push(p);
                      }
                    }
                    return next;
                  });

                  setSelectedFolder(nextPath);
                  setRenameFolderOpen(false);
                  toast.success("Folder renamed");
                } catch (err: any) {
                  toast.error("Could not rename folder", { description: err?.message ?? "Unknown error" });
                } finally {
                  setFolderMutating(false);
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>Create a folder even if it’s empty. Use “/” for nesting (e.g. `prod/api`).</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="new-folder-path">Folder path</Label>
            <Input
              id="new-folder-path"
              value={newFolderPath}
              onChange={(e) => {
                setNewFolderPath(e.target.value);
                setNewFolderError(null);
              }}
              placeholder="e.g. prod/api"
            />
            {newFolderError && <div className="text-sm text-destructive">{newFolderError}</div>}
          </div>

          <DialogFooter>
            <Button variant="outline" className="cursor-pointer" onClick={() => setNewFolderOpen(false)}>
              Cancel
            </Button>
            <Button
              className="cursor-pointer"
              onClick={() => {
                const normalized = normalizeFolder(newFolderPath);
                if (!normalized) {
                  setNewFolderError("Enter a folder name.");
                  return;
                }
                if (folderOptions.includes(normalized)) {
                  setNewFolderError("That folder already exists.");
                  return;
                }
                setCustomFolders((prev) => [...prev, normalized]);
                const parentKey = getParentPath(normalized) ?? ROOT_PARENT_KEY;
                setFolderOrderByParent((prev) => {
                  const existing = prev[parentKey] ?? [];
                  if (existing.includes(normalized)) return prev;
                  return { ...prev, [parentKey]: [...existing, normalized] };
                });
                setSelectedFolder(normalized);
                setNewFolderOpen(false);
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


