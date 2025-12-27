import React, { useCallback, useMemo, useState } from "react";
import CheckCard from "./CheckCard";
import {
  Button,
  ConfirmationModal,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui";
import type { Website } from "../../types";
import { cn } from "../../lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { toast } from "sonner";
import {
  ChevronRight,
  Folder,
  Globe,
  Pencil,
  Plus,
  Trash2,
  Palette,
} from "lucide-react";
import { CheckFolderSidebar } from "./CheckFolderSidebar";


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
  const normalized = normalizeFolder(currentPath);
  if (currentPath === "__all__" || !normalized) {
    // Return only checks that have NO folder (root checks)
    return checks.filter((c) => !normalizeFolder(c.folder));
  }
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
  onAddCheck?: () => void;
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
  onAddCheck,
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
  const [newFolderColor, setNewFolderColor] = useState("default");

  const [selectedFolder, setSelectedFolder] = useLocalStorage<FolderKey>("checks-folder-view-selected-v1", "__all__");
  const [collapsed, setCollapsed] = useLocalStorage<string[]>("checks-folder-view-collapsed-v1", []);
  const [folderColors, setFolderColors] = useLocalStorage<Record<string, string>>("checks-folder-view-colors-v1", {});

  const folderColorOptions = [
    { label: "Default", value: "default", bg: "bg-blue-500", text: "text-blue-500", border: "border-blue-500/20", hoverBorder: "group-hover:border-blue-500/40", lightBg: "bg-blue-500/10", fill: "fill-blue-500/40" },
    { label: "Emerald", value: "emerald", bg: "bg-emerald-500", text: "text-emerald-500", border: "border-emerald-500/20", hoverBorder: "group-hover:border-emerald-500/40", lightBg: "bg-emerald-500/10", fill: "fill-emerald-500/40" },
    { label: "Amber", value: "amber", bg: "bg-amber-500", text: "text-amber-500", border: "border-amber-500/20", hoverBorder: "group-hover:border-amber-500/40", lightBg: "bg-amber-500/10", fill: "fill-amber-500/40" },
    { label: "Rose", value: "rose", bg: "bg-rose-500", text: "text-rose-500", border: "border-rose-500/20", hoverBorder: "group-hover:border-rose-500/40", lightBg: "bg-rose-500/10", fill: "fill-rose-500/40" },
    { label: "Violet", value: "violet", bg: "bg-violet-500", text: "text-violet-500", border: "border-violet-500/20", hoverBorder: "group-hover:border-violet-500/40", lightBg: "bg-violet-500/10", fill: "fill-violet-500/40" },
    { label: "Slate", value: "slate", bg: "bg-slate-500", text: "text-slate-500", border: "border-slate-500/20", hoverBorder: "group-hover:border-slate-500/40", lightBg: "bg-slate-500/10", fill: "fill-slate-500/40" },
  ];

  const getFolderTheme = useCallback((path: string, count: number) => {
    const custom = folderColors[path];
    const color = (custom && custom !== "default") ? custom : (count === 0 ? "slate" : "blue");

    const theme = folderColorOptions.find(o => o.value === color) || folderColorOptions[0]!;

    // Override for empty folders that are NOT custom colored
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


  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);

  return (
    <div className="h-auto min-h-[600px] grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-0 min-w-0 max-w-full rounded-xl border border-border shadow-2xl bg-background/50 backdrop-blur-sm">
      {/* Folder tree (Sidebar) */}
      <CheckFolderSidebar
        checks={checks}
        selectedFolder={selectedFolder}
        collapsedFolders={collapsed}
        onSelectFolder={select}
        onToggleCollapse={toggleCollapsed}
        onNewFolder={() => {
          setNewFolderError(null);
          setNewFolderPath("");
          setNewFolderColor("default");
          setNewFolderOpen(true);
        }}
        isNano={isNano}
        onSetFolder={onSetFolder}
        draggingCheckId={draggingCheckId}
        draggingFolderPath={draggingFolderPath}
        onDragFolderStart={setDraggingFolderPath}
        onDragFolderEnd={() => setDraggingFolderPath(null)}
        onFolderReorder={(parentKey, newOrder) => {
          setFolderOrderByParent((prev) => ({ ...prev, [parentKey]: newOrder }));
        }}
        onMobileTreeClose={() => setMobileTreeOpen(false)}
        headerLabel="Navigation"
        allLabel="All Checks"
        sectionLabel="Folders"
      />

      {/* Main Content Area */}
      <main className="flex flex-col min-w-0 max-w-full bg-background">
        {/* Navigation Bar / Toolbar */}
        <header className={cn(
          "h-14 border-b transition-colors duration-300 flex items-center justify-between px-4 gap-4 flex-shrink-0 rounded-t-xl lg:rounded-tl-none lg:rounded-tr-xl",
          cn(getFolderTheme(selectedFolderPath || "__all__", checksInFolder.length).lightBg, getFolderTheme(selectedFolderPath || "__all__", checksInFolder.length).border)
        )}>
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {/* Back button for mobile or nested */}
            {selectedFolder !== "__all__" && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full lg:hidden"
                onClick={() => setMobileTreeOpen(true)}
              >
                <ChevronRight className="size-4 rotate-180" />
              </Button>
            )}

            {/* Path / Breadcrumbs */}
            <div className={cn(
              "flex items-center h-8 px-2 rounded-lg border transition-colors overflow-hidden min-w-0",
              cn("bg-background/40", getFolderTheme(selectedFolderPath || "__all__", checksInFolder.length).border.replace("border-", "border-"))
            )}>
              {breadcrumbParts.map((c, idx) => (
                <React.Fragment key={`${c.key}-${idx}`}>
                  {idx > 0 && <ChevronRight className="size-3 text-muted-foreground/50 mx-1 shrink-0" />}
                  <button
                    type="button"
                    className={cn(
                      "text-xs font-medium truncate transition-colors min-w-0",
                      idx === breadcrumbParts.length - 1
                        ? getFolderTheme(selectedFolderPath || "__all__", checksInFolder.length).text
                        : "text-muted-foreground hover:text-foreground"
                    )}
                    onClick={idx === breadcrumbParts.length - 1 ? undefined : () => select(c.key)}
                  >
                    {c.label === "All checks" ? "Checks" : c.label}
                  </button>
                </React.Fragment>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="text-xs font-mono text-muted-foreground px-2 py-1 bg-muted rounded hidden md:block">
              {checksInFolder.length} {checksInFolder.length === 1 ? 'item' : 'items'}
            </div>

            {selectedFolderPath && isNano && (
              <div className="flex items-center gap-1 border-l border-border pl-2 ml-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
                  title="Rename Folder"
                  onClick={() => {
                    setRenameFolderError(null);
                    setRenameFolderValue(selectedFolderPath);
                    setRenameFolderOpen(true);
                  }}
                >
                  <Pencil className="size-4" />
                </Button>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className={cn(
                        "size-8 rounded-lg transition-colors",
                        folderColors[selectedFolderPath] && folderColors[selectedFolderPath] !== "default"
                          ? getFolderTheme(selectedFolderPath, checksInFolder.length).text
                          : "text-muted-foreground hover:text-foreground"
                      )}
                      title="Folder Color"
                    >
                      <Palette className="size-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-3" align="center">
                    <div className="flex flex-col gap-3">
                      <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Folder Color</span>
                      <div className="grid grid-cols-6 gap-2">
                        {folderColorOptions.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            className={cn(
                              "size-7 rounded-full border-2 transition-all flex items-center justify-center relative overflow-hidden shadow-sm",
                              opt.bg,
                              (folderColors[selectedFolderPath] || "default") === opt.value
                                ? "border-primary scale-110 ring-2 ring-primary/20"
                                : "border-transparent hover:scale-105 opacity-80 hover:opacity-100"
                            )}
                            onClick={() => {
                              setFolderColors(prev => ({ ...prev, [selectedFolderPath]: opt.value }));
                              toast.success(`Color updated to ${opt.label}`);
                            }}
                            title={opt.label}
                          >
                            {(folderColors[selectedFolderPath] || "default") === opt.value && (
                              <div className="size-1.5 bg-white rounded-full shadow-sm" />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>

                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 rounded-lg text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                  title="Delete Folder"
                  onClick={() => setDeleteFolderConfirmOpen(true)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            )}

            <Button
              size="icon"
              variant="ghost"
              className="size-8 rounded-lg relative"
              onClick={() => {
                setNewFolderError(null);
                setNewFolderPath(selectedFolderPath ? `${selectedFolderPath}/` : "");
                setNewFolderColor("default");
                setNewFolderOpen(true);
              }}
            >
              <Plus className="size-4" />
            </Button>
          </div>
        </header>

        {/* Content Area */}
        <ScrollArea className="flex-1">
          <div className="p-4 sm:p-6 space-y-6">
            {/* Folder Grid */}
            {childFolders.length > 0 && (
              <div>
                <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2 px-1">
                  <Folder className="size-3 text-primary/70" /> Folders
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-4">
                  {childFolders.map((f: { path: string; name: string; count: number }) => (
                    <div
                      key={f.path}
                      className="group flex flex-col items-center gap-1.5 text-center cursor-pointer select-none"
                      onClick={() => select(f.path)}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", f.path);
                        e.dataTransfer.effectAllowed = "move";
                        setDraggingFolderPath(f.path);
                      }}
                      onDragEnd={() => setDraggingFolderPath(null)}
                      onDragOver={(e) => {
                        if (draggingCheckId && isNano && onSetFolder) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                        }
                      }}
                      onDrop={async (e) => {
                        e.preventDefault();
                        if (draggingCheckId && isNano && onSetFolder) {
                          await onSetFolder(draggingCheckId, f.path);
                          setDraggingCheckId(null);
                          toast.success("Check moved into folder");
                        }
                      }}
                    >
                      {/* Folder Card */}
                      <div className={cn(
                        "relative flex items-center justify-center size-16 sm:size-20 rounded-xl sm:rounded-2xl transition-all duration-200",
                        "border shadow-sm",
                        getFolderTheme(f.path, f.count).lightBg,
                        getFolderTheme(f.path, f.count).border,
                        getFolderTheme(f.path, f.count).hoverBorder,
                        "group-hover:scale-105 group-hover:shadow-lg",
                        draggingCheckId && "ring-4 ring-primary/30 ring-dashed"
                      )}>
                        <div className={cn(
                          "absolute inset-0 rounded-xl sm:rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity",
                          getFolderTheme(f.path, f.count).lightBg
                        )} />

                        <Folder className={cn(
                          "size-8 sm:size-10 drop-shadow-sm transition-colors",
                          getFolderTheme(f.path, f.count).text,
                          getFolderTheme(f.path, f.count).fill
                        )} />

                        {f.count > 0 && (
                          <div className={cn(
                            "absolute -top-1 -right-1 size-5 text-xs font-bold text-white rounded-full flex items-center justify-center shadow-lg",
                            getFolderTheme(f.path, f.count).bg
                          )}>
                            {f.count}
                          </div>
                        )}
                      </div>
                      <span className="text-xs font-medium truncate w-full px-1 group-hover:text-primary">
                        {f.name}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Checks List */}
            <div className="pt-2">
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2 px-1">
                <Globe className="size-3 text-primary/70" /> Checks
              </h3>
              {checksInFolder.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 bg-muted/10 rounded-2xl border-2 border-dashed border-border/40 text-center px-6">
                  <div className="p-3 rounded-full bg-muted/50 shadow-inner mb-4">
                    <Globe className="size-6 text-muted-foreground/20" />
                  </div>
                  <h4 className="text-sm font-semibold text-foreground mb-1">No checks found</h4>
                  <p className="text-xs text-muted-foreground max-w-[240px] mb-6">
                    This folder is empty. Add a new monitor or organize your checks by moving them here.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 rounded-lg"
                    onClick={onAddCheck}
                  >
                    <Plus className="size-3.5" />
                    Add Check
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-3">
                  {checksInFolder.map((check) => (
                    <div
                      key={check.id}
                      className={cn(
                        "w-full sm:w-[340px]",
                        draggingCheckId === check.id && "opacity-40 grayscale"
                      )}
                      draggable={isNano && !!onSetFolder}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", check.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDraggingCheckId(check.id);
                      }}
                      onDragEnd={() => setDraggingCheckId(null)}
                    >
                      <CheckCard
                        check={check}
                        onCheckNow={onCheckNow}
                        onToggleStatus={onToggleStatus}
                        onEdit={onEdit}
                        onDelete={(c) => setDeletingCheck(c)}
                        onSetFolder={onSetFolder}
                        isNano={isNano}
                        isManuallyChecking={isManuallyChecking(check.id)}
                        folderOptions={folderOptions}
                        hideCheckbox={true}
                        folderColor={selectedFolderPath && folderColors[selectedFolderPath] !== "default" ? folderColors[selectedFolderPath] : undefined}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      </main>

      {/* Mobile folder tree overlay */}
      {mobileTreeOpen && (
        <div className="lg:hidden fixed inset-0 z-50 bg-background/90 backdrop-blur-md flex flex-col p-4 animate-in fade-in zoom-in duration-200">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-xl font-bold">Folders</h2>
            <Button variant="ghost" size="icon" onClick={() => setMobileTreeOpen(false)}>
              <Plus className="size-6 rotate-45" />
            </Button>
          </div>

          <ScrollArea className="flex-1">
            <CheckFolderSidebar
              checks={checks}
              selectedFolder={selectedFolder}
              collapsedFolders={collapsed}
              onSelectFolder={select}
              onToggleCollapse={toggleCollapsed}
              isNano={isNano}
              onSetFolder={onSetFolder}
              draggingCheckId={draggingCheckId}
              draggingFolderPath={draggingFolderPath}
              onDragFolderStart={setDraggingFolderPath}
              onDragFolderEnd={() => setDraggingFolderPath(null)}
              onFolderReorder={(parentKey, newOrder) => {
                setFolderOrderByParent((prev) => ({ ...prev, [parentKey]: newOrder }));
              }}
              onMobileTreeClose={() => setMobileTreeOpen(false)}
              headerLabel="Navigation"
              allLabel="All Checks"
              sectionLabel="Folders"
              mobile={true}
            />
          </ScrollArea>
        </div>
      )}

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
            // Remove colors for deleted folder and its children
            setFolderColors((prev) => {
              const next = { ...prev };
              delete next[selectedFolderPath];
              for (const p of Object.keys(next)) {
                if (folderHasPrefix(p, selectedFolderPath)) {
                  delete next[p];
                }
              }
              return next;
            });

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
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Folder Settings</DialogTitle>
            <DialogDescription>Rename folder and customize its appearance.</DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">
            <div className="space-y-2">
              <Label htmlFor="rename-folder-path" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Folder name</Label>
              <Input
                id="rename-folder-path"
                value={renameFolderValue}
                onChange={(e) => {
                  setRenameFolderValue(e.target.value);
                  setRenameFolderError(null);
                }}
                placeholder="e.g. prod/api"
                className="bg-muted/50"
              />
              {renameFolderError && <div className="text-sm text-destructive">{renameFolderError}</div>}
            </div>
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

                setFolderMutating(true);
                try {
                  const isRenaming = nextPath !== selectedFolderPath;

                  if (isRenaming) {
                    if (folderHasPrefix(nextPath, selectedFolderPath)) {
                      setRenameFolderError("Folder can’t be moved inside itself.");
                      setFolderMutating(false);
                      return;
                    }
                    if (folderOptions.includes(nextPath)) {
                      setRenameFolderError("That folder already exists.");
                      setFolderMutating(false);
                      return;
                    }
                    if (onRenameFolder) await onRenameFolder(selectedFolderPath, nextPath);
                  }

                  // Update colors map
                  setFolderColors((prev) => {
                    if (!isRenaming) return prev; // If not renaming, no color change happens via this dialog
                    const next = { ...prev };
                    const currentColor = prev[selectedFolderPath];

                    // Move color to new path and update prefixes
                    if (currentColor) {
                      delete next[selectedFolderPath];
                      next[nextPath] = currentColor;
                    }

                    // Also update any child folder colors if they had custom colors
                    for (const [p, color] of Object.entries(prev)) {
                      if (p !== selectedFolderPath && folderHasPrefix(p, selectedFolderPath)) {
                        const newChildPath = replaceFolderPrefix(p, selectedFolderPath, nextPath);
                        next[newChildPath] = color;
                        delete next[p];
                      }
                    }
                    return next;
                  });

                  if (isRenaming) {
                    setCustomFolders((prev) => {
                      const next = new Set<string>();
                      for (const raw of prev) {
                        const n = normalizeFolder(raw);
                        if (!n) continue;
                        const transformed = folderHasPrefix(n, selectedFolderPath) ? replaceFolderPrefix(n, selectedFolderPath, nextPath) : n;
                        if (!transformed) continue;
                        next.add(transformed);
                      }
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
                  }

                  setRenameFolderOpen(false);
                  toast.success(isRenaming ? "Folder renamed" : "Settings saved");
                } catch (err: any) {
                  toast.error("Could not update folder", { description: err?.message ?? "Unknown error" });
                } finally {
                  setFolderMutating(false);
                }
              }}
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>Create a folder even if it’s empty. Use “/” for nesting.</DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">
            <div className="space-y-2">
              <Label htmlFor="new-folder-path" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Folder path</Label>
              <Input
                id="new-folder-path"
                value={newFolderPath}
                onChange={(e) => {
                  setNewFolderPath(e.target.value);
                  setNewFolderError(null);
                }}
                placeholder="e.g. prod/api"
                className="bg-muted/50"
              />
              {newFolderError && <div className="text-sm text-destructive">{newFolderError}</div>}
            </div>

            <div className="space-y-3">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Folder Color</Label>
              <div className="grid grid-cols-6 gap-2">
                {folderColorOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={cn(
                      "size-8 rounded-full border-2 transition-all flex items-center justify-center relative overflow-hidden",
                      opt.bg,
                      newFolderColor === opt.value
                        ? "border-primary scale-110 shadow-md ring-2 ring-primary/20"
                        : "border-transparent hover:scale-105 opacity-80 hover:opacity-100"
                    )}
                    onClick={() => setNewFolderColor(opt.value)}
                    title={opt.label}
                  >
                    {newFolderColor === opt.value && (
                      <div className="size-2 bg-white rounded-full shadow-sm animate-in fade-in zoom-in duration-200" />
                    )}
                  </button>
                ))}
              </div>
            </div>
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

                // Save color
                if (newFolderColor !== "default") {
                  setFolderColors(prev => ({ ...prev, [normalized]: newFolderColor }));
                }

                setCustomFolders((prev) => [...prev, normalized]);
                const parentKey = getParentPath(normalized) ?? ROOT_PARENT_KEY;
                setFolderOrderByParent((prev) => {
                  const existing = prev[parentKey] ?? [];
                  if (existing.includes(normalized)) return prev;
                  return { ...prev, [parentKey]: [...existing, normalized] };
                });
                setNewFolderOpen(false);
                toast.success(`Folder created`, {
                  description: `"${normalized}" is ready. You can now drag and drop monitors into it to organize your view.`
                });
              }}
            >
              Create Folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div >
  );
}


