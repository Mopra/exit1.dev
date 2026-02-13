import { useCallback, useMemo, useState } from "react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui";
import type { Website } from "../../types";
import { cn } from "../../lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { toast } from "sonner";
import {
  ArrowUp,
  ChevronLeft,
  Folder,
  Globe,
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
  buildFolderList,
  getChecksInFolder,
  canCreateSubfolder,
  folderHasPrefix,
  replaceFolderPrefix,
  FOLDER_COLORS,
  type FolderInfo,
} from "../../lib/folder-utils";

type FolderKey = "__all__" | string;

export interface CheckFolderViewProps {
  checks: Website[];
  onDelete: (id: string) => void;
  onCheckNow: (id: string) => void;
  onToggleStatus: (id: string, disabled: boolean) => void;
  onToggleMaintenance?: (check: Website) => void;
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
  onToggleMaintenance,
  onEdit,
  isNano = false,
  onSetFolder,
  onRenameFolder,
  onDeleteFolder,
  manualChecksInProgress = [],
  onAddCheck,
}: CheckFolderViewProps) {
  // Persisted state
  const [customFolders, setCustomFolders] = useLocalStorage<string[]>(
    "checks-folder-view-custom-folders-v1",
    []
  );
  const [selectedFolder, setSelectedFolder] = useLocalStorage<FolderKey>(
    "checks-folder-view-selected-v1",
    "__all__"
  );
  const [folderColors, setFolderColors] = useLocalStorage<Record<string, string>>(
    "checks-folder-view-colors-v1",
    {}
  );
  const [folderOrder, setFolderOrder] = useLocalStorage<Record<string, string[]>>(
    "checks-folder-view-order-v2",
    {}
  );

  // UI state
  const [deletingCheck, setDeletingCheck] = useState<Website | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderColor, setNewFolderColor] = useState("default");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [renameFolderPath, setRenameFolderPath] = useState<string | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState("");
  const [renameFolderError, setRenameFolderError] = useState<string | null>(null);
  const [deleteFolderPath, setDeleteFolderPath] = useState<string | null>(null);
  const [folderMutating, setFolderMutating] = useState(false);
  const [draggingCheckId, setDraggingCheckId] = useState<string | null>(null);
  const [draggingFolderPath, setDraggingFolderPath] = useState<string | null>(null);

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

  const selectedFolderPath = useMemo(() => {
    if (selectedFolder === "__all__") return null;
    return normalizeFolder(selectedFolder);
  }, [selectedFolder]);

  // Get the order key for current level
  const currentOrderKey = selectedFolderPath ?? "__root__";

  // Get folders to display at current level, respecting custom order
  const visibleFolders = useMemo(() => {
    let folders: FolderInfo[];
    if (!selectedFolderPath) {
      // At root: show depth-1 folders
      folders = allFolders.filter((f) => f.depth === 1);
    } else {
      // Inside a folder: show its direct children
      folders = allFolders.filter((f) => f.parentPath === selectedFolderPath);
    }

    // Apply custom ordering if available
    const customOrder = folderOrder[currentOrderKey];
    if (customOrder && customOrder.length > 0) {
      const orderMap = new Map(customOrder.map((path, idx) => [path, idx]));
      return [...folders].sort((a, b) => {
        const aIdx = orderMap.get(a.path) ?? Infinity;
        const bIdx = orderMap.get(b.path) ?? Infinity;
        if (aIdx !== bIdx) return aIdx - bIdx;
        // Fall back to alphabetical for folders not in the order
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
    }

    // Default: alphabetical
    return folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }, [allFolders, selectedFolderPath, folderOrder, currentOrderKey]);

  // Get checks at current level
  const checksInFolder = useMemo(
    () => getChecksInFolder(checks, selectedFolderPath),
    [checks, selectedFolderPath]
  );

  // Check count for delete confirmation
  const deleteFolderCheckCount = useMemo(() => {
    if (!deleteFolderPath) return 0;
    return checks.filter((c) => {
      const f = normalizeFolder(c.folder);
      return f && folderHasPrefix(f, deleteFolderPath);
    }).length;
  }, [checks, deleteFolderPath]);

  // Helpers
  const isManuallyChecking = useCallback(
    (checkId: string) => manualChecksInProgress.includes(checkId),
    [manualChecksInProgress]
  );

  const theme = useMemo(
    () => getFolderTheme(folderColors, selectedFolderPath ?? ""),
    [folderColors, selectedFolderPath]
  );

  // Navigation
  const navigateToFolder = useCallback((path: FolderKey) => {
    setSelectedFolder(path);
  }, [setSelectedFolder]);

  const navigateUp = useCallback(() => {
    if (!selectedFolderPath) return;
    const parent = getParentPath(selectedFolderPath);
    setSelectedFolder(parent ?? "__all__");
  }, [selectedFolderPath, setSelectedFolder]);

  // Folder creation
  const handleCreateFolder = useCallback(() => {
    const name = newFolderName.trim();
    if (!name) {
      setNewFolderError("Enter a folder name.");
      return;
    }

    // Build the full path
    const fullPath = selectedFolderPath ? `${selectedFolderPath}/${name}` : name;
    const normalized = normalizeFolder(fullPath);

    if (!normalized) {
      setNewFolderError("Invalid folder name.");
      return;
    }

    if (folderOptions.includes(normalized)) {
      setNewFolderError("A folder with this name already exists.");
      return;
    }

    // Save folder
    setCustomFolders((prev) => [...prev, normalized]);

    // Save color if not default
    if (newFolderColor !== "default") {
      setFolderColors((prev) => ({ ...prev, [normalized]: newFolderColor }));
    }

    setNewFolderOpen(false);
    setNewFolderName("");
    setNewFolderColor("default");
    setNewFolderError(null);
    toast.success("Folder created");
  }, [newFolderName, newFolderColor, selectedFolderPath, folderOptions, setCustomFolders, setFolderColors]);

  // Folder rename
  const handleRenameFolder = useCallback(async () => {
    if (!renameFolderPath) return;

    const newName = renameFolderValue.trim();
    if (!newName) {
      setRenameFolderError("Enter a folder name.");
      return;
    }

    // Build new path preserving parent
    const parent = getParentPath(renameFolderPath);
    const newPath = parent ? `${parent}/${newName}` : newName;
    const normalized = normalizeFolder(newPath);

    if (!normalized) {
      setRenameFolderError("Invalid folder name.");
      return;
    }

    if (normalized === renameFolderPath) {
      // No change
      setRenameFolderPath(null);
      return;
    }

    if (folderOptions.includes(normalized)) {
      setRenameFolderError("A folder with this name already exists.");
      return;
    }

    setFolderMutating(true);
    try {
      // Rename in Firestore
      if (onRenameFolder) {
        await onRenameFolder(renameFolderPath, normalized);
      }

      // Update custom folders
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

      // Update colors
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

      // Update selection if renamed folder was selected
      if (selectedFolderPath && folderHasPrefix(selectedFolderPath, renameFolderPath)) {
        setSelectedFolder(replaceFolderPrefix(selectedFolderPath, renameFolderPath, normalized));
      }

      setRenameFolderPath(null);
      toast.success("Folder renamed");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Could not rename folder", { description: message });
    } finally {
      setFolderMutating(false);
    }
  }, [renameFolderPath, renameFolderValue, folderOptions, selectedFolderPath, onRenameFolder, setCustomFolders, setFolderColors, setSelectedFolder]);

  // Folder delete
  const handleDeleteFolder = useCallback(async () => {
    if (!deleteFolderPath) return;

    setFolderMutating(true);
    try {
      // Delete in Firestore (moves checks up)
      if (onDeleteFolder) {
        await onDeleteFolder(deleteFolderPath);
      }

      // Remove from custom folders
      setCustomFolders((prev) => {
        return prev.filter((f) => {
          const n = normalizeFolder(f);
          return n && !folderHasPrefix(n, deleteFolderPath);
        });
      });

      // Remove colors
      setFolderColors((prev) => {
        const next = { ...prev };
        for (const p of Object.keys(next)) {
          if (folderHasPrefix(p, deleteFolderPath)) {
            delete next[p];
          }
        }
        return next;
      });

      // Navigate up if deleted folder was selected
      if (selectedFolderPath && folderHasPrefix(selectedFolderPath, deleteFolderPath)) {
        const parent = getParentPath(deleteFolderPath);
        setSelectedFolder(parent ?? "__all__");
      }

      setDeleteFolderPath(null);
      toast.success("Folder deleted");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Could not delete folder", { description: message });
    } finally {
      setFolderMutating(false);
    }
  }, [deleteFolderPath, selectedFolderPath, onDeleteFolder, setCustomFolders, setFolderColors, setSelectedFolder]);

  // Color change
  const handleColorChange = useCallback((path: string, color: string) => {
    setFolderColors((prev) => ({ ...prev, [path]: color }));
    toast.success("Color updated");
  }, [setFolderColors]);

  // Folder reorder via drag and drop
  const handleFolderReorder = useCallback((draggedPath: string, targetPath: string) => {
    if (draggedPath === targetPath) return;

    // Get current folder paths in order
    const currentPaths = visibleFolders.map(f => f.path);
    const draggedIdx = currentPaths.indexOf(draggedPath);
    const targetIdx = currentPaths.indexOf(targetPath);

    if (draggedIdx === -1 || targetIdx === -1) return;

    // Reorder
    const newOrder = [...currentPaths];
    newOrder.splice(draggedIdx, 1);
    newOrder.splice(targetIdx, 0, draggedPath);

    // Save the new order
    setFolderOrder((prev) => ({
      ...prev,
      [currentOrderKey]: newOrder,
    }));
  }, [visibleFolders, currentOrderKey, setFolderOrder]);

  // Drag and drop check into folder
  const handleDropOnFolder = useCallback(
    async (folderPath: string) => {
      if (!draggingCheckId || !onSetFolder) return;
      await onSetFolder(draggingCheckId, folderPath);
      setDraggingCheckId(null);
      toast.success("Check moved to folder");
    },
    [draggingCheckId, onSetFolder]
  );

  // Can create subfolder here?
  const canCreateHere = canCreateSubfolder(selectedFolderPath);

  return (
    <div className="flex flex-col min-h-[500px] rounded-xl border border-border bg-background/50 backdrop-blur-sm shadow-lg overflow-hidden">
      {/* Header */}
      <header
        className={cn(
          "flex items-center justify-between px-4 h-14 border-b shrink-0",
          selectedFolderPath ? cn(theme.lightBg, theme.border) : "bg-muted/30"
        )}
      >
        <div className="flex items-center gap-3 min-w-0">
          {selectedFolderPath && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={navigateUp}
            >
              <ChevronLeft className="size-4" />
            </Button>
          )}

          <div className="flex items-center gap-2 min-w-0">
            {selectedFolderPath ? (
              <>
                <Folder className={cn("size-5 shrink-0", theme.text, theme.fill)} />
                <span className="font-semibold truncate">{getFolderName(selectedFolderPath)}</span>
              </>
            ) : (
              <>
                <Globe className="size-5 text-primary shrink-0" />
                <span className="font-semibold">All Checks</span>
              </>
            )}
          </div>

          <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded-full ml-2">
            {checksInFolder.length} {checksInFolder.length === 1 ? "check" : "checks"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {canCreateHere && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                setNewFolderName("");
                setNewFolderColor("default");
                setNewFolderError(null);
                setNewFolderOpen(true);
              }}
            >
              <Plus className="size-3.5" />
              <span className="hidden sm:inline">New Folder</span>
            </Button>
          )}
        </div>
      </header>

      {/* Drop zone to move check out of folder */}
      {draggingCheckId && selectedFolderPath && (
        <div className="px-4 pt-4 sm:px-6 sm:pt-6">
          <div
            className="flex items-center justify-center gap-2 p-4 rounded-xl border-2 border-dashed border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10 transition-colors cursor-pointer"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              e.preventDefault();
              const parentPath = getParentPath(selectedFolderPath);
              if (draggingCheckId && onSetFolder) {
                onSetFolder(draggingCheckId, parentPath);
                setDraggingCheckId(null);
                toast.success(parentPath ? `Moved to ${getFolderName(parentPath)}` : "Moved to root");
              }
            }}
          >
            <ArrowUp className="size-4" />
            <span className="text-sm font-medium">
              {getParentPath(selectedFolderPath)
                ? `Move to "${getFolderName(getParentPath(selectedFolderPath)!)}"`
                : "Move to root"}
            </span>
          </div>
        </div>
      )}

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-4 sm:p-6 space-y-6">
          {/* Folders Grid */}
          {visibleFolders.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                <Folder className="size-3" />
                Folders
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {visibleFolders.map((folder) => (
                  <FolderCard
                    key={folder.path}
                    folder={folder}
                    colors={folderColors}
                    isCheckDragTarget={!!draggingCheckId}
                    isDragging={draggingFolderPath === folder.path}
                    isFolderDragTarget={!!draggingFolderPath && draggingFolderPath !== folder.path}
                    onNavigate={() => navigateToFolder(folder.path)}
                    onCheckDrop={() => handleDropOnFolder(folder.path)}
                    onFolderDragStart={() => setDraggingFolderPath(folder.path)}
                    onFolderDragEnd={() => setDraggingFolderPath(null)}
                    onFolderDrop={() => {
                      if (draggingFolderPath) {
                        handleFolderReorder(draggingFolderPath, folder.path);
                      }
                    }}
                    onRename={() => {
                      setRenameFolderValue(getFolderName(folder.path));
                      setRenameFolderError(null);
                      setRenameFolderPath(folder.path);
                    }}
                    onDelete={() => setDeleteFolderPath(folder.path)}
                    onColorChange={(color) => handleColorChange(folder.path, color)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Checks List */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
              <Globe className="size-3" />
              Checks
            </h3>

            {checksInFolder.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 bg-muted/20 rounded-xl border-2 border-dashed border-border/40">
                <div className="p-3 rounded-full bg-muted/50 mb-4">
                  <Globe className="size-6 text-muted-foreground/30" />
                </div>
                <h4 className="text-sm font-medium mb-1">No checks here</h4>
                <p className="text-xs text-muted-foreground text-center max-w-[200px] mb-4">
                  {selectedFolderPath
                    ? "Drag checks into this folder or add a new check."
                    : "Create a check to start monitoring."}
                </p>
                {onAddCheck && (
                  <Button variant="outline" size="sm" onClick={onAddCheck}>
                    <Plus className="size-3.5 mr-1.5" />
                    Add Check
                  </Button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {checksInFolder.map((check) => (
                  <CheckCard
                    key={check.id}
                    check={check}
                    onCheckNow={onCheckNow}
                    onToggleStatus={onToggleStatus}
                    onToggleMaintenance={onToggleMaintenance}
                    onEdit={onEdit}
                    onDelete={(c) => setDeletingCheck(c)}
                    onSetFolder={onSetFolder}
                    isNano={isNano}
                    isManuallyChecking={isManuallyChecking(check.id)}
                    folderOptions={folderOptions}
                    hideCheckbox
                    showDragHandle={!!onSetFolder}
                    draggable={!!onSetFolder}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", check.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDraggingCheckId(check.id);
                    }}
                    onDragEnd={() => setDraggingCheckId(null)}
                    className={cn(draggingCheckId === check.id && "opacity-40")}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>

      {/* Delete Check Modal */}
      <ConfirmationModal
        isOpen={!!deletingCheck}
        onClose={() => setDeletingCheck(null)}
        onConfirm={() => {
          if (!deletingCheck) return;
          onDelete(deletingCheck.id);
          setDeletingCheck(null);
        }}
        title="Delete check"
        message={
          deletingCheck
            ? `This will permanently delete "${deletingCheck.name}".`
            : "This will permanently delete this check."
        }
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />

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
                  ? `${deleteFolderCheckCount} check${deleteFolderCheckCount === 1 ? "" : "s"} will be moved up.`
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
              {selectedFolderPath
                ? `Create a subfolder in "${getFolderName(selectedFolderPath)}".`
                : "Create a new folder to organize your checks."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="new-folder-name">Folder name</Label>
              <Input
                id="new-folder-name"
                value={newFolderName}
                onChange={(e) => {
                  setNewFolderName(e.target.value);
                  setNewFolderError(null);
                }}
                placeholder="e.g. Production"
                autoFocus
              />
              {newFolderError && (
                <p className="text-sm text-destructive">{newFolderError}</p>
              )}
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
            <Button variant="outline" onClick={() => setNewFolderOpen(false)}>
              Cancel
            </Button>
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
              onChange={(e) => {
                setRenameFolderValue(e.target.value);
                setRenameFolderError(null);
              }}
              autoFocus
            />
            {renameFolderError && (
              <p className="text-sm text-destructive">{renameFolderError}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameFolderPath(null)}>
              Cancel
            </Button>
            <Button onClick={handleRenameFolder} disabled={folderMutating}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Folder Card Component with Context Menu and Drag-to-Reorder
interface FolderCardProps {
  folder: FolderInfo;
  colors: Record<string, string>;
  isCheckDragTarget: boolean;
  isDragging: boolean;
  isFolderDragTarget: boolean;
  onNavigate: () => void;
  onCheckDrop: () => void;
  onFolderDragStart: () => void;
  onFolderDragEnd: () => void;
  onFolderDrop: () => void;
  onRename: () => void;
  onDelete: () => void;
  onColorChange: (color: string) => void;
}

function FolderCard({
  folder,
  colors,
  isCheckDragTarget,
  isDragging,
  isFolderDragTarget,
  onNavigate,
  onCheckDrop,
  onFolderDragStart,
  onFolderDragEnd,
  onFolderDrop,
  onRename,
  onDelete,
  onColorChange,
}: FolderCardProps) {
  const theme = getFolderTheme(colors, folder.path);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className={cn(
        "group relative flex flex-col items-center p-4 rounded-xl border cursor-pointer transition-all select-none",
        theme.lightBg,
        theme.border,
        theme.hoverBorder,
        "hover:shadow-md hover:scale-[1.02]",
        isCheckDragTarget && "ring-2 ring-primary ring-dashed",
        isDragging && "opacity-50 scale-95",
        isFolderDragTarget && "ring-2 ring-blue-500 ring-dashed"
      )}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", folder.path);
        e.dataTransfer.effectAllowed = "move";
        onFolderDragStart();
      }}
      onDragEnd={onFolderDragEnd}
      onClick={onNavigate}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      onDragOver={(e) => {
        if (isCheckDragTarget || isFolderDragTarget) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (isCheckDragTarget) {
          onCheckDrop();
        } else if (isFolderDragTarget) {
          onFolderDrop();
        }
      }}
    >
      <Folder className={cn("size-10 mb-2", theme.text, theme.fill)} />
      <span className="text-sm font-medium truncate w-full text-center">
        {folder.name}
      </span>
      {folder.count > 0 && (
        <span className={cn("text-xs mt-1 px-2 py-0.5 rounded-full", theme.lightBg, theme.text)}>
          {folder.count}
        </span>
      )}

      {/* Menu trigger - only this opens the dropdown */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="absolute top-2 right-2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-background/50 transition-opacity"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <MoreHorizontal className="size-4 text-muted-foreground" />
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
                    onClick={() => {
                      onColorChange(c.value);
                      setMenuOpen(false);
                    }}
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
    </div>
  );
}
