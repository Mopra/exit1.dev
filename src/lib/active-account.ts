/**
 * Which account the app is acting on.
 *
 * An account is its owner's uid. Normally that is the signed-in user; a Pro
 * teammate can switch into the owner's account (see AccountProvider). This is
 * module state rather than React state because non-React code needs it too:
 * the callable wrapper (src/lib/callable.ts) stamps it on every request.
 *
 * `null` means "my own account", which is also what the backend assumes when
 * no accountId is sent, so personal use never depends on this being set.
 */

let teamAccountId: string | null = null;

/** The team account being acted on, or null for the signed-in user's own account. */
export function getTeamAccountId(): string | null {
  return teamAccountId;
}

export function setTeamAccountId(accountId: string | null): void {
  teamAccountId = accountId;
}

const storageKey = (uid: string) => `exit1.activeAccount.${uid}`;

/** The account last chosen on this browser, for this user. */
export function readStoredAccountId(uid: string): string | null {
  try {
    return localStorage.getItem(storageKey(uid));
  } catch {
    return null;
  }
}

export function storeAccountId(uid: string, accountId: string | null): void {
  try {
    if (!accountId || accountId === uid) localStorage.removeItem(storageKey(uid));
    else localStorage.setItem(storageKey(uid), accountId);
  } catch {
    // Private mode or storage full: switching still works for this page load.
  }
}
