/**
 * Shared folder utilities for check organization
 * Used by CheckFolderView, CheckTimelineView, CheckTable, CheckCard, and useChecks
 */

// Maximum folder nesting depth (1 = flat, 2 = parent/child)
export const MAX_FOLDER_DEPTH = 2;

// Folder color options. Colors come from --folder-* CSS tokens defined in
// src/style.css — change a token there and every folder accent updates.
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
    bg: "bg-folder-blue",
    text: "text-folder-blue",
    border: "border-folder-blue/20",
    hoverBorder: "hover:border-folder-blue/40",
    lightBg: "bg-folder-blue/10",
    fill: "fill-folder-blue/40",
  },
  {
    label: "Emerald",
    value: "emerald",
    bg: "bg-folder-emerald",
    text: "text-folder-emerald",
    border: "border-folder-emerald/20",
    hoverBorder: "hover:border-folder-emerald/40",
    lightBg: "bg-folder-emerald/10",
    fill: "fill-folder-emerald/40",
  },
  {
    label: "Amber",
    value: "amber",
    bg: "bg-folder-amber",
    text: "text-folder-amber",
    border: "border-folder-amber/20",
    hoverBorder: "hover:border-folder-amber/40",
    lightBg: "bg-folder-amber/10",
    fill: "fill-folder-amber/40",
  },
  {
    label: "Rose",
    value: "rose",
    bg: "bg-folder-rose",
    text: "text-folder-rose",
    border: "border-folder-rose/20",
    hoverBorder: "hover:border-folder-rose/40",
    lightBg: "bg-folder-rose/10",
    fill: "fill-folder-rose/40",
  },
  {
    label: "Violet",
    value: "violet",
    bg: "bg-folder-violet",
    text: "text-folder-violet",
    border: "border-folder-violet/20",
    hoverBorder: "hover:border-folder-violet/40",
    lightBg: "bg-folder-violet/10",
    fill: "fill-folder-violet/40",
  },
  {
    label: "Slate",
    value: "slate",
    bg: "bg-folder-slate",
    text: "text-folder-slate",
    border: "border-folder-slate/20",
    hoverBorder: "hover:border-folder-slate/40",
    lightBg: "bg-folder-slate/10",
    fill: "fill-folder-slate/40",
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
