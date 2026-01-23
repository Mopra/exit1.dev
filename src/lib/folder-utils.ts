/**
 * Shared folder utilities for check organization
 * Used by CheckFolderView, CheckTimelineView, CheckTable, CheckCard, and useChecks
 */

// Maximum folder nesting depth (1 = flat, 2 = parent/child)
export const MAX_FOLDER_DEPTH = 2;

// Folder color options with Tailwind classes
export const FOLDER_COLORS = [
  {
    label: "Default",
    value: "default",
    bg: "bg-muted",
    text: "text-muted-foreground",
    border: "border-border/30",
    hoverBorder: "hover:border-border/60",
    lightBg: "bg-muted/30",
    fill: "fill-muted-foreground/20",
  },
  {
    label: "Blue",
    value: "blue",
    bg: "bg-blue-500",
    text: "text-blue-500",
    border: "border-blue-500/20",
    hoverBorder: "hover:border-blue-500/40",
    lightBg: "bg-blue-500/10",
    fill: "fill-blue-500/40",
  },
  {
    label: "Emerald",
    value: "emerald",
    bg: "bg-emerald-500",
    text: "text-emerald-500",
    border: "border-emerald-500/20",
    hoverBorder: "hover:border-emerald-500/40",
    lightBg: "bg-emerald-500/10",
    fill: "fill-emerald-500/40",
  },
  {
    label: "Amber",
    value: "amber",
    bg: "bg-amber-500",
    text: "text-amber-500",
    border: "border-amber-500/20",
    hoverBorder: "hover:border-amber-500/40",
    lightBg: "bg-amber-500/10",
    fill: "fill-amber-500/40",
  },
  {
    label: "Rose",
    value: "rose",
    bg: "bg-rose-500",
    text: "text-rose-500",
    border: "border-rose-500/20",
    hoverBorder: "hover:border-rose-500/40",
    lightBg: "bg-rose-500/10",
    fill: "fill-rose-500/40",
  },
  {
    label: "Violet",
    value: "violet",
    bg: "bg-violet-500",
    text: "text-violet-500",
    border: "border-violet-500/20",
    hoverBorder: "hover:border-violet-500/40",
    lightBg: "bg-violet-500/10",
    fill: "fill-violet-500/40",
  },
  {
    label: "Slate",
    value: "slate",
    bg: "bg-slate-500",
    text: "text-slate-500",
    border: "border-slate-500/20",
    hoverBorder: "hover:border-slate-500/40",
    lightBg: "bg-slate-500/10",
    fill: "fill-slate-500/40",
  },
] as const;

export type FolderColor = (typeof FOLDER_COLORS)[number];
export type FolderColorValue = FolderColor["value"];

/**
 * Normalize a folder path string
 * - Trims whitespace
 * - Converts backslashes to forward slashes
 * - Removes duplicate slashes
 * - Removes leading/trailing slashes
 * - Returns null for empty strings
 */
export function normalizeFolder(folder?: string | null): string | null {
  const raw = (folder ?? "").trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\s+/g, " ")
    .trim();

  const trimmedSlashes = cleaned.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmedSlashes || null;
}

/**
 * Split a folder path into its component parts
 */
export function splitFolderPath(folder: string): string[] {
  return folder
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Join path parts into a folder path string
 */
export function joinPath(parts: string[]): string {
  return parts.join("/");
}

/**
 * Get the depth of a folder path (1 = root level, 2 = one level deep, etc.)
 */
export function getFolderDepth(path: string | null): number {
  if (!path) return 0;
  return splitFolderPath(path).length;
}

/**
 * Get the parent path of a folder, or null if at root level
 */
export function getParentPath(path: string): string | null {
  const parts = splitFolderPath(path);
  if (parts.length <= 1) return null;
  return joinPath(parts.slice(0, -1));
}

/**
 * Get just the folder name (last part of the path)
 */
export function getFolderName(path: string): string {
  const parts = splitFolderPath(path);
  return parts[parts.length - 1] || path;
}

/**
 * Check if a path starts with a given prefix
 */
export function folderHasPrefix(path: string | null | undefined, prefix: string): boolean {
  const normalized = normalizeFolder(path);
  if (!normalized) return false;
  return normalized === prefix || normalized.startsWith(prefix + "/");
}

/**
 * Replace a folder prefix with a new prefix (for renaming)
 */
export function replaceFolderPrefix(
  path: string,
  fromPrefix: string,
  toPrefix: string
): string {
  if (path === fromPrefix) return toPrefix;
  if (path.startsWith(fromPrefix + "/")) {
    return toPrefix + path.slice(fromPrefix.length);
  }
  return path;
}

/**
 * Check if a subfolder can be created under the given parent path
 * Enforces MAX_FOLDER_DEPTH
 */
export function canCreateSubfolder(parentPath: string | null): boolean {
  const parentDepth = getFolderDepth(parentPath);
  return parentDepth < MAX_FOLDER_DEPTH;
}

/**
 * Get the theme/styling for a folder based on its color setting
 */
export function getFolderTheme(
  colors: Record<string, string>,
  path: string
): FolderColor {
  const colorValue = colors[path];
  if (colorValue && colorValue !== "default") {
    const found = FOLDER_COLORS.find((c) => c.value === colorValue);
    if (found) return found;
  }
  return FOLDER_COLORS[0]; // Default
}

/**
 * Get all unique folder paths from an array of checks
 */
export function getUniqueFolders(
  checks: Array<{ folder?: string | null }>
): string[] {
  const set = new Set<string>();
  for (const check of checks) {
    const normalized = normalizeFolder(check.folder);
    if (normalized) set.add(normalized);
  }
  return [...set].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

/**
 * Build a flat list of folder info with counts, grouped by parent
 */
export interface FolderInfo {
  path: string;
  name: string;
  count: number;
  parentPath: string | null;
  depth: number;
}

export function buildFolderList(
  checks: Array<{ folder?: string | null }>,
  customFolders: string[] = []
): FolderInfo[] {
  const folderCounts = new Map<string, number>();
  const allPaths = new Set<string>();

  // Count checks per folder and collect all paths
  for (const check of checks) {
    const folder = normalizeFolder(check.folder);
    if (folder) {
      folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
      allPaths.add(folder);

      // Also add parent paths to ensure hierarchy is complete
      const parent = getParentPath(folder);
      if (parent) allPaths.add(parent);
    }
  }

  // Add custom folders
  for (const f of customFolders) {
    const normalized = normalizeFolder(f);
    if (normalized) {
      allPaths.add(normalized);
      const parent = getParentPath(normalized);
      if (parent) allPaths.add(parent);
    }
  }

  // Build folder info list
  const folders: FolderInfo[] = [];
  for (const path of allPaths) {
    folders.push({
      path,
      name: getFolderName(path),
      count: folderCounts.get(path) ?? 0,
      parentPath: getParentPath(path),
      depth: getFolderDepth(path),
    });
  }

  // Sort: first by depth, then alphabetically
  return folders.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
  });
}

/**
 * Get root-level folders (depth === 1)
 */
export function getRootFolders(folders: FolderInfo[]): FolderInfo[] {
  return folders.filter((f) => f.depth === 1);
}

/**
 * Get child folders of a given parent path
 */
export function getChildFolders(
  folders: FolderInfo[],
  parentPath: string
): FolderInfo[] {
  return folders.filter((f) => f.parentPath === parentPath);
}

/**
 * Get checks that belong directly to a folder (not in subfolders)
 */
export function getChecksInFolder<T extends { folder?: string | null }>(
  checks: T[],
  folderPath: string | null
): T[] {
  if (!folderPath) {
    // Root level: checks with no folder
    return checks.filter((c) => !normalizeFolder(c.folder));
  }
  return checks.filter((c) => normalizeFolder(c.folder) === folderPath);
}

/**
 * Get total check count for a folder including all subfolders
 */
export function getTotalCheckCount(
  checks: Array<{ folder?: string | null }>,
  folderPath: string
): number {
  return checks.filter((c) => {
    const f = normalizeFolder(c.folder);
    return f && folderHasPrefix(f, folderPath);
  }).length;
}
