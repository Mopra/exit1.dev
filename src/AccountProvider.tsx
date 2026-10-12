import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import { useAuthReady } from './AuthReadyProvider';
import { LoadingScreen } from './components/ui';
import { readStoredAccountId, setTeamAccountId, storeAccountId } from './lib/active-account';

export type TeamRole = 'editor' | 'viewer';
export type AccountRole = 'owner' | TeamRole;

export interface TeamAccount {
  accountId: string;
  role: TeamRole;
  ownerName: string | null;
  ownerEmail: string | null;
  /** False while the owner is off Pro: the membership is kept but grants nothing. */
  active: boolean;
}

export interface TeamInvitation {
  id: string;
  ownerName: string | null;
  ownerEmail: string | null;
  role: TeamRole;
  expiresAt: number;
}

export interface AccountState {
  /** The signed-in person. Personal things (billing, profile, preferences) use this. */
  actorUid: string | null;
  /** The account being acted on: the owner's uid. Every `userId` query and new doc uses this. */
  accountId: string | null;
  /** True while acting inside someone else's account. */
  isMember: boolean;
  role: AccountRole;
  /** False for viewers. */
  canWrite: boolean;
  /** The team account being acted on, when isMember. */
  activeTeam: TeamAccount | null;
  teams: TeamAccount[];
  invites: TeamInvitation[];
  loading: boolean;
  /** Switch account (null = my own) and reload into it. */
  switchAccount: (accountId: string | null) => void;
  refresh: () => Promise<void>;
}

const AccountContext = createContext<AccountState | null>(null);

export function teamAccountLabel(team: Pick<TeamAccount, 'ownerName' | 'ownerEmail'>): string {
  return team.ownerName || team.ownerEmail || 'Team account';
}

/**
 * Decides which account the app acts on and exposes it to the tree. Mounted
 * inside AuthReadyProvider. A teammate who last worked inside a team account
 * lands back in it; if that access is gone they drop to their own account.
 */
export function AccountProvider({ children }: { children: React.ReactNode }) {
  const { userId, isSignedIn } = useAuth();
  const authReady = useAuthReady();
  const [teams, setTeams] = useState<TeamAccount[]>([]);
  const [invites, setInvites] = useState<TeamInvitation[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      // Personal call: the raw callable, never the account-stamping wrapper.
      const fn = httpsCallable(functions, 'getTeamContext');
      const res = await fn({});
      const data = (res.data as { data?: { accounts?: TeamAccount[]; invites?: TeamInvitation[] } })?.data;
      setTeams(Array.isArray(data?.accounts) ? data!.accounts! : []);
      setInvites(Array.isArray(data?.invites) ? data!.invites! : []);
    } catch (error) {
      // Not fatal: the user simply works in their own account.
      console.warn('[AccountProvider] Could not load team context', error);
      setTeams([]);
      setInvites([]);
    } finally {
      setLoadedFor(userId);
    }
  }, [userId]);

  useEffect(() => {
    if (authReady && isSignedIn && userId && loadedFor !== userId) {
      void refresh();
    }
    if (!isSignedIn) {
      setTeams([]);
      setInvites([]);
      setLoadedFor(null);
    }
  }, [authReady, isSignedIn, userId, loadedFor, refresh]);

  const stored = userId ? readStoredAccountId(userId) : null;
  const wantsTeam = !!stored && stored !== userId;
  const loading = !!isSignedIn && loadedFor !== userId;

  const activeTeam = useMemo(() => {
    if (!wantsTeam || loading) return null;
    return teams.find((t) => t.accountId === stored && t.active) ?? null;
  }, [wantsTeam, loading, teams, stored]);

  // Stored choice no longer valid (removed, or owner left Pro): forget it.
  useEffect(() => {
    if (userId && wantsTeam && !loading && !activeTeam) {
      storeAccountId(userId, null);
    }
  }, [userId, wantsTeam, loading, activeTeam]);

  // Set synchronously during render so the callable wrapper sees it before
  // any child effect fires a request.
  setTeamAccountId(activeTeam ? activeTeam.accountId : null);

  const switchAccount = useCallback((accountId: string | null) => {
    if (!userId) return;
    storeAccountId(userId, accountId);
    // A full reload is the simplest way to guarantee every listener, cache and
    // in-flight request restarts against the new account.
    window.location.assign('/checks');
  }, [userId]);

  const value = useMemo<AccountState>(() => {
    const role: AccountRole = activeTeam ? activeTeam.role : 'owner';
    return {
      actorUid: userId ?? null,
      accountId: activeTeam ? activeTeam.accountId : (userId ?? null),
      isMember: !!activeTeam,
      role,
      canWrite: role !== 'viewer',
      activeTeam,
      teams,
      invites,
      loading,
      switchAccount,
      refresh,
    };
  }, [activeTeam, userId, teams, invites, loading, switchAccount, refresh]);

  // Someone returning into a team account waits for the check, so they never
  // see their own data flash before the team's (or the reverse).
  if (wantsTeam && loading) {
    return <LoadingScreen type="auth" message="Loading your team" loadingState="loading" />;
  }

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountState {
  const ctx = useContext(AccountContext);
  if (!ctx) {
    throw new Error('useAccount must be used inside AccountProvider');
  }
  return ctx;
}

/** Same as useAccount, but null outside the provider (for shared hooks). */
export function useOptionalAccount(): AccountState | null {
  return useContext(AccountContext);
}

/** The account id to use for data (`userId` fields and queries). */
export function useAccountId(): string | null {
  return useAccount().accountId;
}
