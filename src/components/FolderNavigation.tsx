import { useMemo } from "react";
import { Badge, ScrollArea } from "./ui";
import { cn } from "../lib/utils";
import { Folder, ChevronRight, Activity } from "lucide-react";
import type { Website } from "../types";

type FolderKey = "__all__" | string;

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

type FolderNode = {
    name: string;
    path: string;
    children: Map<string, FolderNode>;
    checkCount: number;
};

function buildFolderTree(checks: Website[]) {
    const root: FolderNode = { name: "", path: "", children: new Map(), checkCount: 0 };
    const folderCounts = new Map<string, number>();

    for (const c of checks) {
        const folder = normalizeFolder(c.folder);
        if (!folder) {
            root.checkCount++;
            continue;
        }

        folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);

        const parts = splitFolderPath(folder);
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

    const applyCounts = (node: FolderNode) => {
        if (node.path) node.checkCount = folderCounts.get(node.path) ?? 0;
        for (const child of node.children.values()) applyCounts(child);
    };
    applyCounts(root);

    return { root, folderCounts };
}

export interface FolderNavigationProps {
    checks: Website[];
    selectedFolder: FolderKey;
    collapsedFolders: string[];
    onSelectFolder: (folder: FolderKey) => void;
    onToggleCollapse: (path: string) => void;
    allLabel?: string;
    sectionLabel?: string;
}

export function FolderNavigation({
    checks,
    selectedFolder,
    collapsedFolders,
    onSelectFolder,
    onToggleCollapse,
    allLabel = "All Checks",
    sectionLabel = "Folders",
}: FolderNavigationProps) {
    const { root } = useMemo(() => buildFolderTree(checks), [checks]);
    const collapsedSet = useMemo(() => new Set(collapsedFolders), [collapsedFolders]);


    const renderNode = (node: FolderNode, depth = 0) => {
        const isCollapsed = collapsedSet.has(node.path);
        const isSelected = selectedFolder === node.path;
        const hasChildren = node.children.size > 0;

        return (
            <div key={node.path} className="min-w-0">
                <div
                    className={cn(
                        "group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium transition-all cursor-pointer select-none mb-0.5",
                        isSelected
                            ? "bg-primary/10 text-primary shadow-sm"
                            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                    )}
                    style={{ paddingLeft: 8 + depth * 12 }}
                    onClick={() => onSelectFolder(node.path)}
                >
                    {hasChildren ? (
                        <button
                            type="button"
                            className="size-5 shrink-0 inline-flex items-center justify-center rounded hover:bg-muted/80 transition-transform"
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleCollapse(node.path);
                            }}
                        >
                            <ChevronRight className={cn("size-3.5 transition-transform duration-200", !isCollapsed && "rotate-90")} />
                        </button>
                    ) : (
                        <span className="size-5 shrink-0" />
                    )}
                    <Folder className={cn(
                        "size-4 shrink-0 transition-colors",
                        isSelected ? "text-primary fill-primary/20" : "text-muted-foreground/60"
                    )} />
                    <span className="truncate flex-1">{depth === 0 && !node.path ? "Root" : node.name}</span>
                    {node.checkCount > 0 && (
                        <Badge variant="secondary" className="h-4 px-1 text-[10px] font-bold bg-muted/50">
                            {node.checkCount}
                        </Badge>
                    )}
                </div>

                {hasChildren && !isCollapsed && (
                    <div className="animate-in slide-in-from-left-2 duration-200">
                        {Array.from(node.children.values())
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map((child) => renderNode(child, depth + 1))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="flex flex-col h-full">
            <div className="p-4 space-y-4">
                <div
                    className={cn(
                        "group flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold transition-all cursor-pointer select-none",
                        selectedFolder === "__all__"
                            ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                            : "text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                    )}
                    onClick={() => onSelectFolder("__all__")}
                >
                    <Activity className="size-4 shrink-0" />
                    <span className="truncate flex-1">{allLabel}</span>
                    <Badge variant={selectedFolder === "__all__" ? "outline" : "secondary"} className="text-[10px] font-bold px-1.5 h-4 border-white/20">
                        {checks.length}
                    </Badge>
                </div>

                <div className="pt-2 border-t border-border/10">
                    <div className="flex items-center justify-between px-3 mb-3">
                        <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider opacity-60">{sectionLabel}</span>
                    </div>
                    {renderNode(root)}
                </div>
            </div>
        </div>
    );
}

export function FolderNavigationSidebar({
    checks,
    selectedFolder,
    collapsedFolders,
    onSelectFolder,
    onToggleCollapse,
    allLabel = "All Checks",
    sectionLabel = "Folders",
    headerLabel = "Navigation",
}: FolderNavigationProps & { headerLabel?: string }) {
    return (
        <aside className="hidden lg:flex flex-col border-r border-border/50 bg-muted/20 backdrop-blur-xl">
            <div className="p-5 flex items-center justify-between border-b border-border/10">
                <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-[0.2em] opacity-70">{headerLabel}</span>
            </div>
            <ScrollArea className="flex-1">
                <FolderNavigation
                    checks={checks}
                    selectedFolder={selectedFolder}
                    collapsedFolders={collapsedFolders}
                    onSelectFolder={onSelectFolder}
                    onToggleCollapse={onToggleCollapse}
                    allLabel={allLabel}
                    sectionLabel={sectionLabel}
                />
            </ScrollArea>
        </aside>
    );
}
