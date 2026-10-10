// Folder filter for GET /v1/public/checks?folder=Personal/Radio[&recursive=true].
//
// checks.folder is a path string ("Personal/Radio"). The query narrows on a
// Firestore range over folder, which can't share a query with the list's
// orderBy('orderIndex'), so the matched docs are sorted and paged in memory.
// A folder holds at most a user's check cap, so the set stays small.

/** Same rules as normalizeFolder in src/lib/folder-utils.ts. */
export function normalizeFolderParam(folder: string | null | undefined): string | null {
  const raw = (folder ?? '').trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return cleaned || null;
}

/**
 * Firestore range [start, end) holding the folder itself and every subfolder.
 * '0' is the character after '/', so "Personal/Radio" and "Personal/Radio/x"
 * fall inside. So does "Personal/Radio-old" (any next char below '0'), which
 * is why results still go through folderMatches.
 */
export function folderRange(folder: string): { start: string; end: string } {
  return { start: folder, end: `${folder}0` };
}

export function folderMatches(checkFolder: unknown, folder: string, recursive: boolean): boolean {
  const normalized = normalizeFolderParam(typeof checkFolder === 'string' ? checkFolder : null);
  if (!normalized) return false;
  if (normalized === folder) return true;
  return recursive && normalized.startsWith(`${folder}/`);
}

type Orderable = { id: string; orderIndex: number };

/** Same order as the unfiltered list: orderIndex, then document id. */
export function compareByOrder(a: Orderable, b: Orderable): number {
  if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * One page of an already sorted list, by cursor (rows after it) or by page
 * number when there is no cursor.
 */
export function pageInMemory<T extends Orderable>(
  sorted: T[],
  opts: { limit: number; page: number; cursor: { orderIndex: number; id: string } | null },
): T[] {
  const { limit, page, cursor } = opts;
  if (cursor) {
    const start = sorted.findIndex(row => compareByOrder(row, cursor) > 0);
    return start === -1 ? [] : sorted.slice(start, start + limit);
  }
  const offset = (page - 1) * limit;
  return sorted.slice(offset, offset + limit);
}

/** Same limits as getFolderPathError in src/lib/folder-utils.ts. */
export const MAX_FOLDER_DEPTH = 10;
export const MAX_FOLDER_SEGMENT_LENGTH = 48;

export function folderPathError(folder: string): string | null {
  const parts = folder.split('/').filter(Boolean);
  if (parts.length > MAX_FOLDER_DEPTH) {
    return `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep`;
  }
  if (parts.some((p) => p.length > MAX_FOLDER_SEGMENT_LENGTH)) {
    return `Folder names can be at most ${MAX_FOLDER_SEGMENT_LENGTH} characters each`;
  }
  return null;
}
