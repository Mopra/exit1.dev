import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckTile } from "./CheckTile";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  BulkActionsBar,
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui";
import type { Website } from "../../types";
import { cn } from "../../lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMobile } from "../../hooks/useMobile";
import { getTypeIcon } from "../../lib/check-utils";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Folder,
  Minus,
  MoreHorizontal,
  Palette,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  normalizeFolder,
  getFolderTheme,
  getFolderName,
  getParentPath,
  getFolderPathError,
  buildFolderList,
  getChecksInFolder,
  canCreateSubfolder,
  folderHasPrefix,
  replaceFolderPrefix,
  FOLDER_COLORS,
  type FolderInfo,
} from "../../lib/folder-utils";

export interface CheckFolderViewProps {
  checks: Website[];
  onSetFolder?: (id: string, folder: string | null) => void | Promise<void>;
  onRenameFolder?: (fromFolder: string, toFolder: string) => void | Promise<void>;
  onDeleteFolder?: (folder: string) => void | Promise<void>;
  onBulkMoveToFolder?: (ids: string[], folder: string | null) => Promise<void>;
}

// ---------- Health helpers ----------

type Health = "down" | "degraded" | "maintenance" | "up" | "paused" | "unknown";

function getHealth(c: Website): Health {
  if (c.disabled) return "paused";
  if (c.maintenanceMode) return "maintenance";
  if (c.status === "offline" || c.detailedStatus === "DOWN") return "down";
  if (c.status === "degraded" || c.detailedStatus === "REACHABLE_WITH_ERROR") return "degraded";
  if (c.status === "online") return "up";
  return "unknown";
}

const HEALTH_LED: Record<Health, string> = {
  down: "bg-destructive",
  degraded: "bg-warning",
  maintenance: "bg-warning",
  up: "bg-primary",
  paused: "bg-muted-foreground/30",
  unknown: "bg-muted-foreground/30",
};

const HEALTH_LABEL: Record<Health, string> = {
  down: "Down",
  degraded: "Degraded",
  maintenance: "Maintenance",
  up: "Up",
  paused: "Paused",
  unknown: "Pending",
};

interface HealthSummary { total: number; down: number; degraded: number; up: number; paused: number }

function summarize(list: Website[]): HealthSummary {
  const s: HealthSummary = { total: list.length, down: 0, degraded: 0, up: 0, paused: 0 };
  for (const c of list) {
    const h = getHealth(c);
    if (h === "down") s.down++;
    else if (h === "degraded" || h === "maintenance") s.degraded++;
    else if (h === "up") s.up++;
    else if (h === "paused") s.paused++;
  }
  return s;
}

// Worst state wins, so a folder with one down check reads as down.
function summaryLed(s: HealthSummary): string {
  if (s.down > 0) return HEALTH_LED.down;
  if (s.degraded > 0) return HEALTH_LED.degraded;
  if (s.up > 0) return HEALTH_LED.up;
  return HEALTH_LED.unknown;
}

function displayHost(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");
}

function checksUnder(checks: Website[], path: string): Website[] {
  return checks.filter((c) => {
    const f = normalizeFolder(c.folder);
    return !!f && folderHasPrefix(f, path);
  });
}

function HealthLed({ className, pulse }: { className: string; pulse?: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0">
      {pulse && <span className={cn("absolute inset-0 rounded-full animate-ping opacity-60", className)} />}
      <span className={cn("relative size-2 rounded-full", className)} />
    </span>
  );
}

function SummaryText({ s }: { s: HealthSummary }) {
  if (s.total === 0) return <span className="text-muted-foreground/60">Empty</span>;
  if (s.down > 0) return <span className="text-destructive font-medium">{s.down} down</span>;
  if (s.degraded > 0) return <span className="text-warning font-medium">{s.degraded} degraded</span>;
  if (s.up === s.total) return <span className="text-muted-foreground">All up</span>;
  return <span className="text-muted-foreground">{s.up} of {s.total} up</span>;
}

export default function CheckFolderView({
  checks,
  onSetFolder,
  onRenameFolder,
  onDeleteFolder,
  onBulkMoveToFolder,
}: CheckFolderViewProps) {
  const isMobile = useMobile(640);
  const navigate = useNavigate();

  // Persisted state
  const [customFolders, setCustomFolders] = useLocalStorage<string[]>(
    "checks-folder-view-custom-folders-v1",
    []
  );
  const [folderColors, setFolderColors] = useLocalStorage<Record<string, string>>(
    "checks-folder-view-colors-v1",
    {}
  );
  const [collapsed, setCollapsed] = useLocalStorage<Record<string, boolean>>(
    "checks-folder-tree-collapsed-v1",
    {}
  );
  // Folder sort order. Keys are folder paths; value is position within siblings.
  // Folders without an entry sort after ordered ones, alphabetically.
  const [folderOrder, setFolderOrder] = useLocalStorage<Record<string, number>>(
    "checks-folder-view-order-v1",
    {}
  );

  // UI state — folder dialogs
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderColor, setNewFolderColor] = useState("default");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [renameFolderPath, setRenameFolderPath] = useState<string | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState("");
  const [renameFolderError, setRenameFolderError] = useState<string | null>(null);
  const [deleteFolderPath, setDeleteFolderPath] = useState<string | null>(null);
  const [folderMutating, setFolderMutating] = useState(false);

  // Drag state
  const [draggingCheckId, setDraggingCheckId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // folder path or "__unsorted__"
  const [draggingFolderPath, setDraggingFolderPath] = useState<string | null>(null);
  const [folderDropTarget, setFolderDropTarget] = useState<{ path: string; position: "before" | "after" } | null>(null);

  // Selection state
  const [selectedChecks, setSelectedChecks] = useState<Set<string>>(new Set());
  const lastClickedIndexRef = useRef<number | null>(null);
  const [folderMoveOpen, setFolderMoveOpen] = useState(false);

  // Drill-in zoom
  const [zoomPath, setZoomPath] = useState<string | null>(null);

  // Derived data
  const normalizedCustomFolders = useMemo(() => {
    const set = new Set<string>();
    for (const f of customFolders) {
      const n = normalizeFolder(f);
      if (n) set.add(n);
    }
    return [...set];
  }, [customFolders]);

  const allFolders = useMemo(
    () => buildFolderList(checks, normalizedCustomFolders),
    [checks, normalizedCustomFolders]
  );

  const folderOptions = useMemo(() => allFolders.map((f) => f.path), [allFolders]);

  const siblingComparator = useCallback((a: FolderInfo, b: FolderInfo) => {
    const oa = folderOrder[a.path];
    const ob = folderOrder[b.path];
    const hasA = typeof oa === "number";
    const hasB = typeof ob === "number";
    if (hasA && hasB && oa !== ob) return oa - ob;
    if (hasA && !hasB) return -1;
    if (!hasA && hasB) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  }, [folderOrder]);

  const rootFolders = useMemo(
    () => allFolders.filter((f) => f.depth === 1).slice().sort(siblingComparator),
    [allFolders, siblingComparator]
  );

  const unsortedChecks = useMemo(
    () => getChecksInFolder(checks, null),
    [checks]
  );

  // Reset zoom if the zoomed folder was deleted/renamed away
  useEffect(() => {
    if (zoomPath && !allFolders.some((f) => f.path === zoomPath)) {
      setZoomPath(null);
    }
  }, [zoomPath, allFolders]);

  // Helpers
  const getSubfolders = useCallback(
    (parentPath: string) =>
      allFolders.filter((sf) => sf.parentPath === parentPath).slice().sort(siblingComparator),
    [allFolders, siblingComparator]
  );

  // Ordered list of visible checks (for shift-click range + bulk selection)
  const allVisibleChecks = useMemo(() => {
    const result: Website[] = [];
    const walkFolder = (f: FolderInfo) => {
      // Root folders obey collapsed state only on mobile, but treat desktop as always-expanded
      if (isMobile && collapsed[f.path]) return;
      for (const sub of getSubfolders(f.path)) walkFolder(sub);
      result.push(...getChecksInFolder(checks, f.path));
    };

    if (zoomPath) {
      const zoomed = allFolders.find((f) => f.path === zoomPath);
      if (!zoomed) return result;
      result.push(...getChecksInFolder(checks, zoomed.path));
      for (const sub of getSubfolders(zoomed.path)) walkFolder(sub);
      return result;
    }

    for (const f of rootFolders) walkFolder(f);
    if (!isMobile || !collapsed["__unsorted__"]) result.push(...unsortedChecks);
    return result;
  }, [isMobile, collapsed, rootFolders, unsortedChecks, allFolders, checks, zoomPath, getSubfolders]);

  // Delete-confirmation count
  const deleteFolderCheckCount = useMemo(
    () => (deleteFolderPath ? checksUnder(checks, deleteFolderPath).length : 0),
    [checks, deleteFolderPath]
  );

  // Selection
  const handleSelectCheck = useCallback((checkId: string, event?: React.MouseEvent) => {
    const currentIndex = allVisibleChecks.findIndex((c) => c.id === checkId);

    if (event?.shiftKey && lastClickedIndexRef.current !== null && lastClickedIndexRef.current < allVisibleChecks.length) {
      const start = Math.min(lastClickedIndexRef.current, currentIndex);
      const end = Math.max(lastClickedIndexRef.current, currentIndex);
      const newSelected = new Set(selectedChecks);
      for (let i = start; i <= end; i++) newSelected.add(allVisibleChecks[i].id);
      setSelectedChecks(newSelected);
    } else {
      const newSelected = new Set(selectedChecks);
      if (newSelected.has(checkId)) newSelected.delete(checkId);
      else newSelected.add(checkId);
      setSelectedChecks(newSelected);
    }
    lastClickedIndexRef.current = currentIndex;
  }, [selectedChecks, allVisibleChecks]);

  const clearSelection = useCallback(() => {
    setSelectedChecks(new Set());
    lastClickedIndexRef.current = null;
  }, []);

  const checkIds = useMemo(() => checks.map((c) => c.id).join(","), [checks]);
  useEffect(() => {
    setSelectedChecks(new Set());
    lastClickedIndexRef.current = null;
  }, [checkIds]);

  // Folder CRUD
  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }, [setCollapsed]);

  const openNewFolderDialog = useCallback((parentPath: string | null) => {
    setNewFolderParent(parentPath);
    setNewFolderName("");
    setNewFolderColor("default");
    setNewFolderError(null);
    setNewFolderOpen(true);
  }, []);

  const handleCreateFolder = useCallback(() => {
    const name = newFolderName.trim();
    if (!name) { setNewFolderError("Enter a folder name."); return; }
    const fullPath = newFolderParent ? `${newFolderParent}/${name}` : name;
    const normalized = normalizeFolder(fullPath);
    if (!normalized) { setNewFolderError("Invalid folder name."); return; }
    const lengthError = getFolderPathError(normalized);
    if (lengthError) { setNewFolderError(lengthError); return; }
    if (folderOptions.includes(normalized)) {
      setNewFolderError("A folder with this name already exists.");
      return;
    }
    setCustomFolders((prev) => [...prev, normalized]);
    if (newFolderColor !== "default") {
      setFolderColors((prev) => ({ ...prev, [normalized]: newFolderColor }));
    }
    setNewFolderOpen(false);
    setNewFolderName("");
    setNewFolderColor("default");
    setNewFolderError(null);
    toast.success("Folder created");
  }, [newFolderName, newFolderColor, newFolderParent, folderOptions, setCustomFolders, setFolderColors]);

  const handleRenameFolder = useCallback(async () => {
    if (!renameFolderPath) return;
    const newName = renameFolderValue.trim();
    if (!newName) { setRenameFolderError("Enter a folder name."); return; }
    const parent = getParentPath(renameFolderPath);
    const newPath = parent ? `${parent}/${newName}` : newName;
    const normalized = normalizeFolder(newPath);
    if (!normalized) { setRenameFolderError("Invalid folder name."); return; }
    const lengthError = getFolderPathError(normalized);
    if (lengthError) { setRenameFolderError(lengthError); return; }
    if (normalized === renameFolderPath) { setRenameFolderPath(null); return; }
    if (folderOptions.includes(normalized)) {
      setRenameFolderError("A folder with this name already exists.");
      return;
    }
    setFolderMutating(true);
    try {
      if (onRenameFolder) await onRenameFolder(renameFolderPath, normalized);
      setCustomFolders((prev) => {
        const next = new Set<string>();
        for (const raw of prev) {
          const n = normalizeFolder(raw);
          if (!n) continue;
          if (folderHasPrefix(n, renameFolderPath)) {
            next.add(replaceFolderPrefix(n, renameFolderPath, normalized));
          } else {
            next.add(n);
          }
        }
        next.add(normalized);
        return [...next];
      });
      setFolderColors((prev) => {
        const next = { ...prev };
        for (const [p, color] of Object.entries(prev)) {
          if (folderHasPrefix(p, renameFolderPath)) {
            const newP = replaceFolderPrefix(p, renameFolderPath, normalized);
            next[newP] = color;
            delete next[p];
          }
        }
        return next;
      });
      if (zoomPath && folderHasPrefix(zoomPath, renameFolderPath)) {
        setZoomPath(replaceFolderPrefix(zoomPath, renameFolderPath, normalized));
      }
      setRenameFolderPath(null);
      toast.success("Folder renamed");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Could not rename folder", { description: message });
    } finally {
      setFolderMutating(false);
    }
  }, [renameFolderPath, renameFolderValue, folderOptions, onRenameFolder, setCustomFolders, setFolderColors, zoomPath]);

  const handleDeleteFolder = useCallback(async () => {
    if (!deleteFolderPath) return;
    setFolderMutating(true);
    try {
      if (onDeleteFolder) await onDeleteFolder(deleteFolderPath);
      setCustomFolders((prev) => prev.filter((f) => {
        const n = normalizeFolder(f);
        return n && !folderHasPrefix(n, deleteFolderPath);
      }));
      setFolderColors((prev) => {
        const next = { ...prev };
        for (const p of Object.keys(next)) {
          if (folderHasPrefix(p, deleteFolderPath)) delete next[p];
        }
        return next;
      });
      if (zoomPath && folderHasPrefix(zoomPath, deleteFolderPath)) {
        setZoomPath(null);
      }
      setDeleteFolderPath(null);
      toast.success("Folder deleted");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Could not delete folder", { description: message });
    } finally {
      setFolderMutating(false);
    }
  }, [deleteFolderPath, onDeleteFolder, setCustomFolders, setFolderColors, zoomPath]);

  const handleColorChange = useCallback((path: string, color: string) => {
    setFolderColors((prev) => ({ ...prev, [path]: color }));
    toast.success("Color updated");
  }, [setFolderColors]);

  // Reorder folders among siblings (same parent)
  const handleFolderReorder = useCallback(
    (sourcePath: string, targetPath: string, position: "before" | "after") => {
      if (sourcePath === targetPath) return;
      const source = allFolders.find((f) => f.path === sourcePath);
      const target = allFolders.find((f) => f.path === targetPath);
      if (!source || !target) return;
      if (source.parentPath !== target.parentPath) return;

      const siblings = allFolders
        .filter((f) => f.parentPath === source.parentPath)
        .slice()
        .sort(siblingComparator);

      const without = siblings.filter((f) => f.path !== sourcePath);
      const targetIdx = without.findIndex((f) => f.path === targetPath);
      if (targetIdx < 0) return;
      const insertAt = position === "after" ? targetIdx + 1 : targetIdx;
      const reordered = [...without.slice(0, insertAt), source, ...without.slice(insertAt)];

      setFolderOrder((prev) => {
        const next = { ...prev };
        reordered.forEach((f, i) => { next[f.path] = i; });
        return next;
      });
    },
    [allFolders, siblingComparator, setFolderOrder]
  );

  // Drag & drop
  const handleDrop = useCallback(async (targetFolder: string | null) => {
    if (!draggingCheckId || !onSetFolder) return;
    await onSetFolder(draggingCheckId, targetFolder);
    setDraggingCheckId(null);
    setDropTarget(null);
    toast.success(targetFolder ? `Moved to ${getFolderName(targetFolder)}` : "Moved to Unsorted");
  }, [draggingCheckId, onSetFolder]);

  const dragOverTarget = useCallback((e: React.DragEvent, target: string | null) => {
    if (!draggingCheckId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(target ?? "__unsorted__");
  }, [draggingCheckId]);

  const dragLeaveTarget = useCallback(() => setDropTarget(null), []);

  const dropOnTarget = useCallback((e: React.DragEvent, target: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    handleDrop(target);
  }, [handleDrop]);

  // Breadcrumb for zoom view
  const breadcrumb = useMemo(() => {
    if (!zoomPath) return [] as FolderInfo[];
    const parts: FolderInfo[] = [];
    let p: string | null = zoomPath;
    while (p) {
      const f = allFolders.find((af) => af.path === p);
      if (!f) break;
      parts.unshift(f);
      p = f.parentPath;
    }
    return parts;
  }, [zoomPath, allFolders]);

  const hasAnyContent = rootFolders.length > 0 || unsortedChecks.length > 0;

  // Header summary covers whatever is in view: the whole account, or the zoomed folder.
  const overallSummary = useMemo(
    () => summarize(zoomPath ? checksUnder(checks, zoomPath) : checks),
    [checks, zoomPath]
  );

  // ---------- Check row (inside a folder card) ----------

  const renderCheckTile = useCallback((check: Website, parentPath: string | null) => {
    const isSelected = selectedChecks.has(check.id);
    const isDragging = draggingCheckId === check.id;
    const health = getHealth(check);
    const selecting = selectedChecks.size > 0;
    const showLatency = (health === "up" || health === "degraded") && typeof check.responseTime === "number";
    return (
      <div
        key={`check-${check.id}`}
        role="button"
        tabIndex={0}
        className={cn(
          "group/row relative flex items-center gap-2.5 h-9 pl-2 pr-2.5 rounded-md cursor-pointer select-none transition-colors outline-none",
          "hover:bg-foreground/[0.04] focus-visible:ring-1 focus-visible:ring-primary/50",
          isSelected && "bg-primary/[0.07] hover:bg-primary/[0.1]",
          health === "down" && !isSelected && "bg-destructive/[0.06] hover:bg-destructive/[0.1]",
          health === "paused" && "opacity-60",
          isDragging && "opacity-40"
        )}
        draggable={!!onSetFolder}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData("text/plain", check.id);
          e.dataTransfer.effectAllowed = "move";
          setDraggingCheckId(check.id);
        }}
        onDragEnd={() => { setDraggingCheckId(null); setDropTarget(null); }}
        onDragOver={(e) => {
          if (!draggingCheckId || draggingCheckId === check.id) return;
          dragOverTarget(e, parentPath);
        }}
        onDrop={(e) => {
          if (!draggingCheckId || draggingCheckId === check.id) return;
          dropOnTarget(e, parentPath);
        }}
        onClick={(e) => {
          // A modifier click, or any click while a selection is active, selects.
          // A plain click opens the check.
          if (e.shiftKey || e.metaKey || e.ctrlKey || selecting) handleSelectCheck(check.id, e);
          else navigate(`/checks/${check.id}`);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") navigate(`/checks/${check.id}`);
          if (e.key === " ") { e.preventDefault(); handleSelectCheck(check.id); }
        }}
        title={`${check.name}: ${HEALTH_LABEL[health]}`}
      >
        {/* Status LED, swapped for a checkbox on hover or while selecting */}
        <span className="relative size-4 shrink-0 flex items-center justify-center">
          <span className={cn("transition-opacity", isSelected || selecting ? "opacity-0" : "group-hover/row:opacity-0")}>
            <HealthLed className={HEALTH_LED[health]} pulse={health === "down"} />
          </span>
          <button
            type="button"
            tabIndex={-1}
            aria-label={isSelected ? "Deselect check" : "Select check"}
            className={cn(
              "absolute inset-0 rounded-[4px] border flex items-center justify-center transition-opacity",
              isSelected
                ? "bg-primary border-primary text-primary-foreground opacity-100"
                : cn("border-muted-foreground/40 hover:border-primary/70", selecting ? "opacity-100" : "opacity-0 group-hover/row:opacity-100")
            )}
            onClick={(e) => { e.stopPropagation(); handleSelectCheck(check.id, e); }}
          >
            {isSelected && <Check className="size-3" strokeWidth={3} />}
          </button>
        </span>
        {getTypeIcon(check.type, "size-3.5 shrink-0 text-muted-foreground/70")}
        <span className="text-[13px] font-medium tracking-tight truncate shrink-0 max-w-[55%]">{check.name}</span>
        <span className="text-[12px] text-muted-foreground/55 truncate flex-1 min-w-0">{displayHost(check.url)}</span>
        <span className={cn(
          "text-[11.5px] tabular-nums shrink-0 font-mono",
          health === "down"
            ? "text-destructive"
            : health === "degraded" || health === "maintenance"
              ? "text-warning"
              : "text-muted-foreground/70"
        )}>
          {showLatency ? `${check.responseTime}ms` : HEALTH_LABEL[health]}
        </span>
      </div>
    );
  }, [selectedChecks, draggingCheckId, onSetFolder, dragOverTarget, dropOnTarget, handleSelectCheck, navigate]);

  // ---------- Folder card (recursive) ----------

  const renderFolderCard = useCallback(
    (folder: FolderInfo, nested = false): React.ReactNode => {
      const theme = getFolderTheme(folderColors, folder.path);
      const isCheckDropActive = dropTarget === folder.path;
      const isBeingDragged = draggingFolderPath === folder.path;
      const isFolderDropTarget = folderDropTarget?.path === folder.path;
      const subfolders = getSubfolders(folder.path);
      const folderChecks = getChecksInFolder(checks, folder.path);
      const summary = summarize(checksUnder(checks, folder.path));
      const canAddSub = canCreateSubfolder(folder.path);
      const hasBody = subfolders.length > 0 || folderChecks.length > 0;
      const isCustomColor = theme.value !== "default";

      const canReorderWith =
        draggingFolderPath &&
        draggingFolderPath !== folder.path &&
        (() => {
          const s = allFolders.find((f) => f.path === draggingFolderPath);
          return !!s && s.parentPath === folder.parentPath;
        })();

      return (
        <div
          key={folder.path}
          draggable
          className={cn(
            "group/card relative break-inside-avoid border transition-colors overflow-hidden",
            nested ? "rounded-lg bg-foreground/[0.015]" : "mb-4 rounded-xl bg-card",
            "border-border/50 hover:border-border",
            summary.down > 0 && !nested && "border-destructive/30 hover:border-destructive/50",
            draggingCheckId && !isCheckDropActive && "border-dashed",
            isCheckDropActive && "ring-2 ring-inset ring-primary/60 bg-primary/[0.06]",
            isBeingDragged && "opacity-40"
          )}
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData("application/x-folder-path", folder.path);
            e.dataTransfer.effectAllowed = "move";
            setDraggingFolderPath(folder.path);
          }}
          onDragEnd={() => {
            setDraggingFolderPath(null);
            setFolderDropTarget(null);
          }}
          onDragOver={(e) => {
            if (canReorderWith) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              const rect = e.currentTarget.getBoundingClientRect();
              const position: "before" | "after" = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
              setFolderDropTarget({ path: folder.path, position });
              return;
            }
            if (draggingCheckId) {
              dragOverTarget(e, folder.path);
            }
          }}
          onDragLeave={(e) => {
            if (draggingFolderPath) {
              // Only clear if we've actually left the card (not crossed into a child)
              const related = e.relatedTarget as Node | null;
              if (related && e.currentTarget.contains(related)) return;
              if (folderDropTarget?.path === folder.path) setFolderDropTarget(null);
              return;
            }
            dragLeaveTarget();
          }}
          onDrop={(e) => {
            if (draggingFolderPath && canReorderWith) {
              e.preventDefault();
              e.stopPropagation();
              const pos = folderDropTarget?.position ?? "before";
              handleFolderReorder(draggingFolderPath, folder.path, pos);
              setDraggingFolderPath(null);
              setFolderDropTarget(null);
              return;
            }
            if (draggingCheckId) {
              dropOnTarget(e, folder.path);
            }
          }}
        >
          {/* Folder color accent */}
          {isCustomColor && (
            <div className={cn("pointer-events-none absolute left-0 top-0 bottom-0 w-[3px]", theme.bg)} />
          )}

          {/* Reorder indicator */}
          {isFolderDropTarget && folderDropTarget?.position === "before" && (
            <div className="pointer-events-none absolute top-0 left-0 right-0 h-0.5 bg-primary" />
          )}
          {isFolderDropTarget && folderDropTarget?.position === "after" && (
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
          )}

          {/* Header */}
          <div
            className={cn(
              "flex items-center gap-2 cursor-pointer",
              hasBody && "border-b border-border/30",
              nested ? "h-8 pl-2.5 pr-1" : "h-11 pl-3.5 pr-2"
            )}
            onClick={() => setZoomPath(folder.path)}
            title={`Open ${folder.name}`}
          >
            <HealthLed className={summaryLed(summary)} pulse={summary.down > 0} />
            <Folder
              className={cn("size-3.5 shrink-0", isCustomColor ? theme.text : "text-muted-foreground/70")}
              strokeWidth={1.75}
            />
            <span className={cn(
              "font-semibold tracking-tight truncate min-w-0",
              nested ? "text-[12.5px]" : "text-[13.5px]"
            )}>
              {folder.name}
            </span>
            <span className="text-[11.5px] tabular-nums text-muted-foreground/60 shrink-0">{summary.total}</span>
            <span className="flex-1" />
            <span className="text-[11.5px] tabular-nums shrink-0 pr-1"><SummaryText s={summary} /></span>
            <div className="flex items-center opacity-0 group-hover/card:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 transition-opacity">
              {canAddSub && (
                <button
                  type="button"
                  className="shrink-0 size-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08] transition-colors"
                  onClick={(e) => { e.stopPropagation(); openNewFolderDialog(folder.path); }}
                  title="Add subfolder"
                >
                  <Plus className="size-3.5" strokeWidth={2} />
                </button>
              )}
              <div onClick={(e) => e.stopPropagation()}>
                <FolderMenu
                  folder={folder}
                  colors={folderColors}
                  onRename={() => {
                    setRenameFolderValue(getFolderName(folder.path));
                    setRenameFolderError(null);
                    setRenameFolderPath(folder.path);
                  }}
                  onDelete={() => setDeleteFolderPath(folder.path)}
                  onColorChange={(color) => handleColorChange(folder.path, color)}
                  compact
                />
              </div>
            </div>
          </div>

          {/* Body */}
          {hasBody ? (
            <div className={cn(nested ? "p-1" : "p-1.5")}>
              {subfolders.length > 0 && (
                <div className={cn("space-y-1.5 p-1", folderChecks.length > 0 && "pb-1.5")}>
                  {subfolders.map((sf) => renderFolderCard(sf, true))}
                </div>
              )}
              {folderChecks.length > 0 && (
                <div className="flex flex-col">
                  {folderChecks.map((c) => renderCheckTile(c, folder.path))}
                </div>
              )}
            </div>
          ) : (
            !nested && (
              <p className="px-4 py-3 text-[11.5px] text-muted-foreground/60 border-t border-border/30">
                Drag checks here
              </p>
            )
          )}
        </div>
      );
    },
    [
      folderColors,
      dropTarget,
      draggingFolderPath,
      folderDropTarget,
      draggingCheckId,
      allFolders,
      checks,
      getSubfolders,
      dragOverTarget,
      dragLeaveTarget,
      dropOnTarget,
      openNewFolderDialog,
      handleColorChange,
      handleFolderReorder,
      renderCheckTile,
    ]
  );

  // ---------- Unsorted card ----------

  const renderUnsortedCard = useCallback(() => {
    const isDropActive = dropTarget === "__unsorted__";
    const isEmpty = unsortedChecks.length === 0;
    const summary = summarize(unsortedChecks);
    return (
      <div
        key="unsorted"
        className={cn(
          "break-inside-avoid mb-4 rounded-xl border border-dashed transition-colors overflow-hidden",
          "border-border/50 bg-transparent",
          isDropActive && "ring-2 ring-inset ring-primary/60 bg-primary/[0.06] border-solid"
        )}
        onDragOver={(e) => {
          if (draggingFolderPath) return; // folder reordering, not a valid drop here
          dragOverTarget(e, null);
        }}
        onDragLeave={dragLeaveTarget}
        onDrop={(e) => {
          if (draggingFolderPath) return;
          dropOnTarget(e, null);
        }}
      >
        <div className={cn("flex items-center gap-2 pl-3.5 pr-3 h-11", !isEmpty && "border-b border-border/30")}>
          <HealthLed className={isEmpty ? HEALTH_LED.unknown : summaryLed(summary)} pulse={summary.down > 0} />
          <span className="text-[13.5px] font-semibold tracking-tight truncate text-muted-foreground">Unsorted</span>
          <span className="text-[11.5px] tabular-nums text-muted-foreground/60 shrink-0">{summary.total}</span>
          <span className="flex-1" />
          {!isEmpty && <span className="text-[11.5px] tabular-nums shrink-0"><SummaryText s={summary} /></span>}
        </div>
        {isEmpty ? (
          <p className="px-4 py-3 text-[11.5px] text-muted-foreground/60">
            Drop checks here to take them out of folders
          </p>
        ) : (
          <div className="p-1.5 flex flex-col">
            {unsortedChecks.map((c) => renderCheckTile(c, null))}
          </div>
        )}
      </div>
    );
  }, [dropTarget, unsortedChecks, dragOverTarget, dragLeaveTarget, dropOnTarget, renderCheckTile, draggingFolderPath]);

  // ---------- Mobile list render (unchanged) ----------

  const renderMobileFolderRow = (folder: FolderInfo, depth: number): React.ReactNode => {
    const theme = getFolderTheme(folderColors, folder.path);
    const isCollapsed = !!collapsed[folder.path];
    const subfolders = getSubfolders(folder.path);
    const folderChecks = getChecksInFolder(checks, folder.path);
    const hasChildren = subfolders.length > 0 || folderChecks.length > 0;

    return (
      <div key={folder.path}>
        <div
          className={cn(
            "group relative flex items-center gap-2.5 h-9 pr-2 rounded-lg transition-colors cursor-pointer select-none",
            theme.value === "default" ? "hover:bg-foreground/[0.04]" : cn(theme.lightBg, "hover:brightness-110"),
            dropTarget === folder.path && "bg-primary/[0.06] ring-1 ring-inset ring-primary/30",
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => toggleCollapsed(folder.path)}
          onDragOver={(e) => dragOverTarget(e, folder.path)}
          onDragLeave={dragLeaveTarget}
          onDrop={(e) => dropOnTarget(e, folder.path)}
        >
          <ChevronRight className={cn(
            "size-3 shrink-0 text-muted-foreground/60 transition-transform duration-200 ease-out",
            !isCollapsed && hasChildren && "rotate-90",
            !hasChildren && "opacity-0"
          )} />
          <div className="flex items-baseline gap-2 min-w-0 flex-1">
            <span className="text-[13.5px] font-medium tracking-tight truncate text-foreground/90">{folder.name}</span>
            {folder.count > 0 && (
              <span className="text-[11px] text-muted-foreground/60 tabular-nums tracking-tight shrink-0">{folder.count}</span>
            )}
          </div>
          <FolderMenu
            folder={folder}
            colors={folderColors}
            onRename={() => {
              setRenameFolderValue(getFolderName(folder.path));
              setRenameFolderError(null);
              setRenameFolderPath(folder.path);
            }}
            onDelete={() => setDeleteFolderPath(folder.path)}
            onColorChange={(color) => handleColorChange(folder.path, color)}
          />
        </div>
        {!isCollapsed && (
          <>
            {subfolders.map((sub) => renderMobileFolderRow(sub, depth + 1))}
            {folderChecks.map((check) => (
              <div key={check.id} style={{ paddingLeft: `${depth * 16 + 16}px` }}>
                <CheckTile
                  check={check}
                  isSelected={selectedChecks.has(check.id)}
                  onSelect={handleSelectCheck}
                  className="border-transparent bg-transparent hover:bg-foreground/[0.04] shadow-none"
                />
              </div>
            ))}
          </>
        )}
      </div>
    );
  };

  // ---------- Zoomed direct checks ----------

  const zoomedFolder = zoomPath ? allFolders.find((f) => f.path === zoomPath) : null;
  const zoomedSubs = zoomedFolder ? getSubfolders(zoomedFolder.path) : [];
  const zoomedDirectChecks = zoomedFolder ? getChecksInFolder(checks, zoomedFolder.path) : [];
  const zoomEmpty = !!zoomedFolder && zoomedSubs.length === 0 && zoomedDirectChecks.length === 0;

  const desktopVisibleFolders = zoomPath ? zoomedSubs : rootFolders;

  // ---------- Main render ----------

  return (
    <div className="flex flex-col min-h-[300px] sm:min-h-[560px]">
      {/* Header */}
      <header className="flex items-end justify-between gap-3 px-1 sm:px-2 pt-1 pb-4 shrink-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {zoomPath && (
              <button
                type="button"
                onClick={() => setZoomPath(null)}
                className="shrink-0 size-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors"
                title="Back to all folders"
              >
                <ArrowLeft className="size-3.5" />
              </button>
            )}
            {zoomPath ? (
              <nav className="flex items-center gap-1 text-[13px] font-semibold tracking-tight min-w-0">
                <button
                  type="button"
                  className={cn(
                    "px-1.5 py-0.5 rounded-md transition-colors",
                    "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]",
                    draggingCheckId && "ring-1 ring-dashed ring-border/70",
                    dropTarget === "__unsorted__" && "bg-primary/10 ring-1 ring-primary/40 text-foreground"
                  )}
                  onClick={() => setZoomPath(null)}
                  onDragOver={(e) => dragOverTarget(e, null)}
                  onDragLeave={dragLeaveTarget}
                  onDrop={(e) => dropOnTarget(e, null)}
                  title={draggingCheckId ? "Drop to move to root (Unsorted)" : undefined}
                >
                  Folders
                </button>
                {breadcrumb.map((f, i) => {
                  const isLast = i === breadcrumb.length - 1;
                  return (
                    <span key={f.path} className="flex items-center gap-1 min-w-0">
                      <ChevronRight className="size-3 text-muted-foreground/50 shrink-0" />
                      <button
                        type="button"
                        className={cn(
                          "truncate px-1.5 py-0.5 rounded-md transition-colors",
                          isLast ? "text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]",
                          draggingCheckId && !isLast && "ring-1 ring-dashed ring-border/70",
                          !isLast && dropTarget === f.path && "bg-primary/10 ring-1 ring-primary/40 text-foreground"
                        )}
                        onClick={() => setZoomPath(isLast ? zoomPath : f.path)}
                        onDragOver={(e) => !isLast && dragOverTarget(e, f.path)}
                        onDragLeave={!isLast ? dragLeaveTarget : undefined}
                        onDrop={(e) => !isLast && dropOnTarget(e, f.path)}
                        title={draggingCheckId && !isLast ? `Drop to move into ${f.name}` : undefined}
                      >
                        {f.name}
                      </button>
                    </span>
                  );
                })}
              </nav>
            ) : (
              <h3 className="text-[15px] font-semibold tracking-tight text-foreground">Folders</h3>
            )}
          </div>
          <p className="text-xs text-muted-foreground/80 tabular-nums flex items-center gap-1.5">
            <span>{overallSummary.total} {overallSummary.total === 1 ? "check" : "checks"}</span>
            {overallSummary.down > 0 && (
              <><span className="text-muted-foreground/40">·</span><span className="text-destructive font-medium">{overallSummary.down} down</span></>
            )}
            {overallSummary.degraded > 0 && (
              <><span className="text-muted-foreground/40">·</span><span className="text-warning font-medium">{overallSummary.degraded} degraded</span></>
            )}
            {overallSummary.paused > 0 && (
              <><span className="text-muted-foreground/40">·</span><span>{overallSummary.paused} paused</span></>
            )}
            {!isMobile && checks.length > 0 && (
              <span className="text-muted-foreground/50 hidden lg:inline">· drag to reorganize, shift-click to select</span>
            )}
          </p>
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 h-8 px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] shrink-0"
          onClick={() => openNewFolderDialog(zoomPath)}
        >
          <Plus className="size-3.5" strokeWidth={2} />
          <span>{zoomPath ? "New Subfolder" : "New Folder"}</span>
        </Button>
      </header>

      {/* Empty state (no checks at all) */}
      {checks.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 sm:py-24 flex-1">
          <Folder className="size-7 text-muted-foreground/30 mb-4" strokeWidth={1.25} />
          <h4 className="text-sm font-medium tracking-tight mb-1">No checks yet</h4>
          <p className="text-xs text-muted-foreground/80 text-center max-w-[260px] leading-relaxed">
            Create checks from the Table view, then organize them into folders here.
          </p>
        </div>
      )}

      {/* Mobile: tree list */}
      {checks.length > 0 && isMobile && (
        <ScrollArea className="flex-1">
          <div className="px-1 pb-2 space-y-0.5">
            {rootFolders.map((folder) => renderMobileFolderRow(folder, 0))}
            {rootFolders.length === 0 && unsortedChecks.length > 0 && (
              <p className="text-xs text-muted-foreground/70 px-3 py-2 mb-1">
                Create a folder to start organizing your checks.
              </p>
            )}
            {unsortedChecks.length > 0 && (
              <div className={cn(rootFolders.length > 0 && "pt-2")}>
                <div
                  className={cn(
                    "group flex items-center gap-2.5 h-9 px-3 pr-2 rounded-lg hover:bg-foreground/[0.04] transition-colors cursor-pointer select-none",
                    dropTarget === "__unsorted__" && "bg-primary/[0.06] ring-1 ring-inset ring-primary/30",
                  )}
                  onClick={() => toggleCollapsed("__unsorted__")}
                  onDragOver={(e) => dragOverTarget(e, null)}
                  onDragLeave={dragLeaveTarget}
                  onDrop={(e) => dropOnTarget(e, null)}
                >
                  <ChevronRight className={cn(
                    "size-3 shrink-0 text-muted-foreground/60 transition-transform duration-200 ease-out",
                    !collapsed["__unsorted__"] && "rotate-90"
                  )} />
                  <div className="flex items-baseline gap-2 min-w-0 flex-1">
                    <span className="text-[13.5px] font-medium tracking-tight truncate text-muted-foreground/80">Unsorted</span>
                    <span className="text-[11px] text-muted-foreground/60 tabular-nums tracking-tight shrink-0">{unsortedChecks.length}</span>
                  </div>
                </div>
                {!collapsed["__unsorted__"] && unsortedChecks.map((check) => (
                  <div key={check.id} style={{ paddingLeft: `16px` }}>
                    <CheckTile
                      check={check}
                      isSelected={selectedChecks.has(check.id)}
                      onSelect={handleSelectCheck}
                      className="border-transparent bg-transparent hover:bg-foreground/[0.04] shadow-none"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      )}

      {/* Desktop: masonry of folder cards */}
      {checks.length > 0 && !isMobile && (
        <div className="flex-1 -mx-1 sm:-mx-2">
          <div className="px-1 sm:px-2 pb-4">
            {!zoomPath && !hasAnyContent && (
              <div className="flex flex-col items-center justify-center py-16 border border-dashed border-border/50 rounded-xl">
                <Folder className="size-7 text-muted-foreground/30 mb-3" strokeWidth={1.25} />
                <p className="text-sm font-medium tracking-tight mb-1">No folders yet</p>
                <p className="text-xs text-muted-foreground/70 text-center max-w-[280px] leading-relaxed mb-4">
                  Create a folder to start organizing your checks.
                </p>
                <Button variant="outline" size="sm" onClick={() => openNewFolderDialog(null)}>
                  <Plus className="size-3.5 mr-1.5" />
                  New Folder
                </Button>
              </div>
            )}

            {!zoomPath && hasAnyContent && (
              <div className="columns-1 lg:columns-2 2xl:columns-3 gap-4">
                {desktopVisibleFolders.map((folder) => renderFolderCard(folder, false))}
                {renderUnsortedCard()}
              </div>
            )}

            {zoomPath && zoomedFolder && (
              <>
                {/* Direct checks of the zoomed folder, rendered as a full-width section at the top */}
                {zoomedDirectChecks.length > 0 && (
                  <div
                    className={cn(
                      "mb-4 rounded-xl border p-1.5 pt-3 transition-colors",
                      "border-border/50 bg-card",
                      dropTarget === zoomedFolder.path && "ring-2 ring-inset ring-primary/60 bg-primary/[0.06]"
                    )}
                    onDragOver={(e) => dragOverTarget(e, zoomedFolder.path)}
                    onDragLeave={dragLeaveTarget}
                    onDrop={(e) => dropOnTarget(e, zoomedFolder.path)}
                  >
                    <p className="text-[10.5px] uppercase tracking-wide text-muted-foreground/70 px-2 pb-2">
                      Directly in {zoomedFolder.name}
                    </p>
                    <div className="grid gap-x-4 lg:grid-cols-2 2xl:grid-cols-3">
                      {zoomedDirectChecks.map((c) => renderCheckTile(c, zoomedFolder.path))}
                    </div>
                  </div>
                )}

                {zoomedSubs.length > 0 && (
                  <div className="columns-1 lg:columns-2 2xl:columns-3 gap-4">
                    {zoomedSubs.map((folder) => renderFolderCard(folder, false))}
                  </div>
                )}

                {zoomEmpty && (
                  <div className="flex flex-col items-center justify-center py-16 border border-dashed border-border/50 rounded-xl">
                    <p className="text-sm font-medium tracking-tight mb-1">Empty folder</p>
                    <p className="text-xs text-muted-foreground/70 text-center max-w-[280px] leading-relaxed mb-4">
                      Drag checks here or create a subfolder.
                    </p>
                    {canCreateSubfolder(zoomedFolder.path) && (
                      <Button variant="outline" size="sm" onClick={() => openNewFolderDialog(zoomedFolder.path)}>
                        <Plus className="size-3.5 mr-1.5" />
                        New Subfolder
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Delete Folder Modal */}
      <ConfirmationModal
        isOpen={!!deleteFolderPath}
        onClose={() => setDeleteFolderPath(null)}
        onConfirm={handleDeleteFolder}
        title="Delete folder"
        message={
          deleteFolderPath
            ? `Delete "${getFolderName(deleteFolderPath)}"? ${
                deleteFolderCheckCount > 0
                  ? `${deleteFolderCheckCount} check${deleteFolderCheckCount === 1 ? "" : "s"} will be moved to Unsorted.`
                  : ""
              }`
            : "Delete this folder?"
        }
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />

      {/* New Folder Dialog */}
      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Folder</DialogTitle>
            <DialogDescription>
              {newFolderParent
                ? `Create a subfolder in "${getFolderName(newFolderParent)}".`
                : "Create a new folder to organize your checks."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="new-folder-name">Folder name</Label>
              <Input
                id="new-folder-name"
                value={newFolderName}
                onChange={(e) => { setNewFolderName(e.target.value); setNewFolderError(null); }}
                placeholder="e.g. Production"
                autoFocus
              />
              {newFolderError && <p className="text-sm text-destructive">{newFolderError}</p>}
            </div>

            <div className="space-y-2">
              <Label>Color</Label>
              <div className="flex gap-2 flex-wrap">
                {FOLDER_COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setNewFolderColor(c.value)}
                    className={cn(
                      "size-8 rounded-full border-2 transition-all",
                      c.value === "default" ? "bg-muted" : c.bg,
                      newFolderColor === c.value
                        ? "border-primary scale-110 ring-2 ring-primary/20"
                        : "border-transparent hover:scale-105"
                    )}
                    title={c.label}
                  >
                    {newFolderColor === c.value && (
                      <div className="size-2 bg-white rounded-full mx-auto" />
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateFolder}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Folder Dialog */}
      <Dialog open={!!renameFolderPath} onOpenChange={(open) => !open && setRenameFolderPath(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename Folder</DialogTitle>
            <DialogDescription>Enter a new name for this folder.</DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-4">
            <Label htmlFor="rename-folder-name">Folder name</Label>
            <Input
              id="rename-folder-name"
              value={renameFolderValue}
              onChange={(e) => { setRenameFolderValue(e.target.value); setRenameFolderError(null); }}
              autoFocus
            />
            {renameFolderError && <p className="text-sm text-destructive">{renameFolderError}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameFolderPath(null)}>Cancel</Button>
            <Button onClick={handleRenameFolder} disabled={folderMutating}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Actions Bar */}
      <BulkActionsBar
        selectedCount={selectedChecks.size}
        totalCount={checks.length}
        onClearSelection={clearSelection}
        itemLabel="check"
        actions={[
          ...(onBulkMoveToFolder ? [{
            label: 'Move to Folder',
            icon: <Folder className="w-3 h-3" />,
            onClick: () => setFolderMoveOpen(true),
            variant: 'ghost' as const,
          }] : []),
        ]}
      />

      {/* Bulk Move to Folder Popover */}
      {onBulkMoveToFolder && (
        <Popover open={folderMoveOpen} onOpenChange={setFolderMoveOpen}>
          <PopoverTrigger asChild>
            <span className="fixed bottom-20 left-1/2 -translate-x-1/2 pointer-events-none" />
          </PopoverTrigger>
          <PopoverContent side="top" align="center" className="w-64 p-2 max-h-64 overflow-y-auto">
            <div className="space-y-1">
              <button
                className="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-muted transition-colors flex items-center gap-2 text-muted-foreground"
                onClick={async () => {
                  await onBulkMoveToFolder(Array.from(selectedChecks), null);
                  clearSelection();
                  setFolderMoveOpen(false);
                }}
              >
                <Minus className="w-3.5 h-3.5" />
                Unsorted
              </button>
              {folderOptions.length > 0 && <div className="h-px bg-border my-1" />}
              {folderOptions.map((folder) => {
                const ft = getFolderTheme(folderColors, folder);
                return (
                  <button
                    key={folder}
                    className="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-muted transition-colors flex items-center gap-2"
                    onClick={async () => {
                      await onBulkMoveToFolder(Array.from(selectedChecks), folder);
                      clearSelection();
                      setFolderMoveOpen(false);
                    }}
                  >
                    <Folder className={cn("w-3.5 h-3.5", ft.text)} />
                    {folder}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

// Inline folder context menu (three-dot)
function FolderMenu({
  folder,
  colors,
  onRename,
  onDelete,
  onColorChange,
  compact = false,
}: {
  folder: FolderInfo;
  colors: Record<string, string>;
  onRename: () => void;
  onDelete: () => void;
  onColorChange: (color: string) => void;
  compact?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "shrink-0 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08] transition-all",
            compact ? "size-7" : "size-6"
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className={cn(compact ? "size-4" : "size-3.5")} />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={onRename}>
          <Pencil className="size-4 mr-2" />
          Rename
        </DropdownMenuItem>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette className="size-4 mr-2" />
            Color
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <div className="p-2 grid grid-cols-4 gap-1.5">
              {FOLDER_COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => { onColorChange(c.value); setMenuOpen(false); }}
                  className={cn(
                    "size-7 rounded-full border-2 transition-all",
                    c.value === "default" ? "bg-muted" : c.bg,
                    colors[folder.path] === c.value || (!colors[folder.path] && c.value === "default")
                      ? "border-primary scale-110"
                      : "border-transparent hover:scale-105"
                  )}
                  title={c.label}
                />
              ))}
            </div>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
          <Trash2 className="size-4 mr-2" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
