// API key expiry and check/folder restrictions.
//
// A key may carry an expiry (expiresAt, ms) and an access list restricting it
// to specific checks and/or folders. A folder grant covers its subfolders.
// No access list (or an empty one) means the key sees every check, as before.
// OAuth (MCP) tokens never carry an access list.
//
// Kept free of firebase-admin so the rules can be unit-tested.
import { folderMatches, normalizeFolderParam } from "./public-api-folder";

export interface KeyAccess {
  checkIds: string[];
  folders: string[];
}

export const KEY_ACCESS_MAX_CHECKS = 200;
export const KEY_ACCESS_MAX_FOLDERS = 50;
/** Shortest and longest expiry a key can be created with. */
export const KEY_EXPIRY_MIN_SECONDS = 5 * 60;
export const KEY_EXPIRY_MAX_SECONDS = 366 * 24 * 60 * 60;

const VALID_DOC_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export class KeyAccessError extends Error {}

/**
 * Validate and normalize the access list sent when creating a key. Returns
 * null for "unrestricted" (missing, or both lists empty). Throws
 * KeyAccessError on bad input. Ownership of the check ids is the caller's job.
 */
export function parseKeyAccess(raw: unknown): KeyAccess | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new KeyAccessError("access must be an object with checkIds and/or folders");
  }
  const { checkIds = [], folders = [] } = raw as { checkIds?: unknown; folders?: unknown };
  if (!Array.isArray(checkIds) || !Array.isArray(folders)) {
    throw new KeyAccessError("access.checkIds and access.folders must be arrays");
  }

  const ids = [...new Set(checkIds.map((id) => (typeof id === "string" ? id.trim() : "")))];
  if (ids.some((id) => !VALID_DOC_ID.test(id))) {
    throw new KeyAccessError("access.checkIds contains an invalid check id");
  }
  if (ids.length > KEY_ACCESS_MAX_CHECKS) {
    throw new KeyAccessError(`A key can be restricted to at most ${KEY_ACCESS_MAX_CHECKS} checks`);
  }

  const normalized = folders.map((f) => normalizeFolderParam(typeof f === "string" ? f : null));
  if (normalized.some((f) => f === null)) {
    throw new KeyAccessError("access.folders contains an empty folder");
  }
  const uniqueFolders = [...new Set(normalized as string[])];
  if (uniqueFolders.length > KEY_ACCESS_MAX_FOLDERS) {
    throw new KeyAccessError(`A key can be restricted to at most ${KEY_ACCESS_MAX_FOLDERS} folders`);
  }

  if (ids.length === 0 && uniqueFolders.length === 0) return null;
  return { checkIds: ids, folders: uniqueFolders };
}

/** Access list as stored on a key doc; anything malformed reads as unrestricted only when absent. */
export function readStoredAccess(raw: unknown): KeyAccess | null {
  if (!raw || typeof raw !== "object") return null;
  const { checkIds, folders } = raw as { checkIds?: unknown; folders?: unknown };
  const ids = Array.isArray(checkIds) ? checkIds.filter((v): v is string => typeof v === "string") : [];
  const fs = Array.isArray(folders) ? folders.filter((v): v is string => typeof v === "string") : [];
  // A stored access object that lost all its entries must not widen to
  // "everything": keep it restricted (to nothing).
  return { checkIds: ids, folders: fs };
}

/** Whether a key with this access list may see a check. null access = unrestricted. */
export function canAccessCheck(access: KeyAccess | null, checkId: string, checkFolder: unknown): boolean {
  if (!access) return true;
  if (access.checkIds.includes(checkId)) return true;
  return access.folders.some((folder) => folderMatches(checkFolder, folder, true));
}

/** Whether a check created into this folder would be visible to the key. */
export function canCreateInFolder(access: KeyAccess | null, folder: unknown): boolean {
  if (!access) return true;
  return access.folders.some((granted) => folderMatches(folder, granted, true));
}

/**
 * Expiry requested at key creation, as seconds from now. Returns null for
 * "never". Throws KeyAccessError when out of range.
 */
export function parseExpiresInSeconds(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === 0) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new KeyAccessError("expiresInSeconds must be a number");
  }
  const seconds = Math.floor(raw);
  if (seconds < KEY_EXPIRY_MIN_SECONDS || seconds > KEY_EXPIRY_MAX_SECONDS) {
    throw new KeyAccessError(
      `expiresInSeconds must be between ${KEY_EXPIRY_MIN_SECONDS} (5 minutes) and ${KEY_EXPIRY_MAX_SECONDS} (366 days)`,
    );
  }
  return seconds;
}

export function isKeyExpired(expiresAt: unknown, now: number): boolean {
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= now;
}
