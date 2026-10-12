import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Copy, LogOut, Mail, RefreshCw, Trash2, UserPlus, Users, ArrowRightLeft, Loader2 } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '../components/ui';
import { PageHeader, PageContainer } from '../components/layout';
import { functions } from '../firebase';
import { httpsCallable } from '@/lib/callable';
import { usePlan } from '@/hooks/usePlan';
import { useAuthReady } from '../AuthReadyProvider';
import { teamAccountLabel, useAccount, type TeamRole } from '@/AccountProvider';
import ConfirmationModal from '@/components/ui/ConfirmationModal';

interface TeamMember {
  memberUid: string;
  email: string;
  name: string | null;
  role: TeamRole;
  joinedAt: number;
}

interface PendingInvite {
  id: string;
  email: string;
  role: TeamRole;
  createdAt: number;
  expiresAt: number;
  link: string;
}

interface TeamData {
  canManage: boolean;
  role: 'owner' | TeamRole;
  ownerTier: string;
  seats: { used: number; total: number };
  members: TeamMember[];
  invites: PendingInvite[];
}

const ROLE_LABEL: Record<TeamRole, string> = {
  editor: 'Editor',
  viewer: 'Viewer',
};

const ROLE_HINT: Record<TeamRole, string> = {
  editor: 'Can add, change and delete checks, alerts and status pages',
  viewer: 'Can see everything, change nothing',
};

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    const msg = (error as { message: string }).message;
    if (msg && msg !== 'INTERNAL' && msg !== 'internal') return msg;
  }
  return fallback;
}

async function call<T = unknown>(name: string, data: Record<string, unknown> = {}): Promise<T> {
  const fn = httpsCallable(functions, name);
  const res = await fn(data);
  return res.data as T;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function RoleSelect({ value, onChange, disabled, id, label }: { value: TeamRole; onChange: (role: TeamRole) => void; disabled?: boolean; id?: string; label?: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TeamRole)} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} className="w-full sm:w-36 cursor-pointer">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(['editor', 'viewer'] as TeamRole[]).map((role) => (
          <SelectItem key={role} value={role} className="cursor-pointer">
            {ROLE_LABEL[role]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const Team: React.FC = () => {
  const account = useAccount();
  const authReady = useAuthReady();
  const { tier } = usePlan();
  const [searchParams, setSearchParams] = useSearchParams();
  const linkInviteId = searchParams.get('invite');

  const [team, setTeam] = useState<TeamData | null>(null);
  const [loadingTeam, setLoadingTeam] = useState(true);
  const [teamError, setTeamError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<TeamRole>('editor');
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<TeamMember | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const loadTeam = useCallback(async () => {
    setLoadingTeam(true);
    setTeamError(null);
    try {
      const res = await call<{ data: TeamData }>('getTeam');
      setTeam(res.data);
    } catch (error) {
      setTeamError(errorMessage(error, 'Could not load your team.'));
    } finally {
      setLoadingTeam(false);
    }
  }, []);

  // Callables need the Firebase session; firing before it exists fails as
  // unauthenticated and leaves the page without a team.
  useEffect(() => {
    if (authReady) void loadTeam();
  }, [authReady, loadTeam]);

  const pendingForMe = useMemo(() => {
    const list = [...account.invites];
    // An invite opened from the email link that isn't in the list (sent to an
    // address this login hasn't verified) still gets a card, so accepting can
    // explain what's wrong instead of the link silently doing nothing.
    // Wait for the team context first, or the generic card flashes before the
    // named one replaces it.
    if (linkInviteId && !account.loading && !list.some((i) => i.id === linkInviteId)) {
      list.unshift({ id: linkInviteId, ownerName: null, ownerEmail: null, role: 'viewer', expiresAt: 0 });
    }
    return list;
  }, [account.invites, account.loading, linkInviteId]);

  const clearInviteParam = () => {
    if (!linkInviteId) return;
    const next = new URLSearchParams(searchParams);
    next.delete('invite');
    setSearchParams(next, { replace: true });
  };

  const acceptInvite = async (inviteId: string) => {
    setBusy(`accept:${inviteId}`);
    try {
      const res = await call<{ data: { accountId: string } }>('acceptTeamInvite', { inviteId });
      toast.success("You've joined the team. Switching you into it now.");
      clearInviteParam();
      account.switchAccount(res.data.accountId);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not accept the invite.'));
      setBusy(null);
    }
  };

  const declineInvite = async (inviteId: string) => {
    setBusy(`decline:${inviteId}`);
    try {
      await call('declineTeamInvite', { inviteId });
      toast.success('Invite declined');
      clearInviteParam();
      await account.refresh();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not decline the invite.'));
    } finally {
      setBusy(null);
    }
  };

  const sendInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    try {
      const res = await call<{ data: PendingInvite & { emailSent: boolean } }>('inviteTeamMember', { email, role: inviteRole });
      if (res.data.emailSent) {
        toast.success(`Invite sent to ${email}`);
      } else {
        toast.warning("Invite created, but the email didn't go out. Copy the link and send it yourself.");
      }
      setInviteEmail('');
      await loadTeam();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not send the invite.'));
    } finally {
      setInviting(false);
    }
  };

  const resendInvite = async (invite: PendingInvite) => {
    setBusy(`resend:${invite.id}`);
    try {
      await call('inviteTeamMember', { email: invite.email, role: invite.role });
      toast.success(`Invite sent again to ${invite.email}`);
      await loadTeam();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not resend the invite.'));
    } finally {
      setBusy(null);
    }
  };

  const revokeInvite = async (invite: PendingInvite) => {
    setBusy(`revoke:${invite.id}`);
    try {
      await call('revokeTeamInvite', { inviteId: invite.id });
      toast.success('Invite cancelled');
      await loadTeam();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not cancel the invite.'));
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Invite link copied');
    } catch {
      toast.error('Could not copy. Select the link and copy it manually.');
    }
  };

  const changeRole = async (member: TeamMember, role: TeamRole) => {
    if (role === member.role) return;
    setBusy(`role:${member.memberUid}`);
    try {
      await call('updateTeamMemberRole', { memberUid: member.memberUid, role });
      toast.success(`${member.name || member.email} is now ${role === 'editor' ? 'an editor' : 'a viewer'}`);
      await loadTeam();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not change the role.'));
    } finally {
      setBusy(null);
    }
  };

  const removeMember = async (member: TeamMember) => {
    setBusy(`remove:${member.memberUid}`);
    try {
      await call('removeTeamMember', { memberUid: member.memberUid });
      toast.success(`${member.name || member.email} was removed from your team`);
      await loadTeam();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not remove the member.'));
    } finally {
      setBusy(null);
      setConfirmRemove(null);
    }
  };

  const leaveTeam = async () => {
    if (!account.activeTeam) return;
    setBusy('leave');
    try {
      await call('leaveTeam', { ownerUid: account.activeTeam.accountId });
      toast.success('You left the team');
      account.switchAccount(null);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not leave the team.'));
      setBusy(null);
      setConfirmLeave(false);
    }
  };

  const isPro = tier === 'pro';
  const seatsFull = !!team && team.seats.used >= team.seats.total;
  const otherTeams = account.teams.filter((t) => t.accountId !== account.accountId);

  return (
    <>
      <PageContainer>
        <PageHeader
          title="Team"
          description={account.isMember
            ? `You're working in ${teamAccountLabel(account.activeTeam!)}'s account`
            : 'Invite teammates to share your checks, alerts and status pages'}
          icon={Users}
        />

        <div className="flex-1 w-full">
          <div className="w-full mx-auto max-w-7xl px-2 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8 space-y-6">

            {pendingForMe.length > 0 && (
              <Card className="bg-card border-0 shadow-lg">
                <CardHeader className="p-4 sm:p-6 lg:p-8">
                  <CardTitle className="text-xl">Invitations</CardTitle>
                  <CardDescription>Join a team to work inside its account. Your own account stays as it is.</CardDescription>
                </CardHeader>
                <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8 space-y-3">
                  {pendingForMe.map((invite) => {
                    const known = invite.expiresAt > 0;
                    return (
                      <div key={invite.id} className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <div className="font-medium truncate">
                            {known ? teamAccountLabel(invite) : 'Team invite'}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {known
                              ? `Invited you as ${invite.role === 'editor' ? 'an editor' : 'a viewer'}. Expires ${formatDate(invite.expiresAt)}.`
                              : 'Opened from an invite link.'}
                          </div>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <Button
                            size="sm"
                            className="cursor-pointer"
                            disabled={!!busy}
                            onClick={() => acceptInvite(invite.id)}
                          >
                            {busy === `accept:${invite.id}` && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                            Accept
                          </Button>
                          {known && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="cursor-pointer"
                              disabled={!!busy}
                              onClick={() => declineInvite(invite.id)}
                            >
                              Decline
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            )}

            {account.isMember && account.activeTeam && (
              <Card className="bg-card border-0 shadow-lg">
                <CardHeader className="p-4 sm:p-6 lg:p-8">
                  <CardTitle className="text-xl">Your access</CardTitle>
                  <CardDescription>
                    You're {account.role === 'editor' ? 'an editor' : 'a viewer'} in {teamAccountLabel(account.activeTeam)}'s account. {ROLE_HINT[account.role as TeamRole]}.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8 flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => account.switchAccount(null)}>
                    <ArrowRightLeft className="w-4 h-4 mr-2" />
                    Switch to my own account
                  </Button>
                  <Button variant="outline" size="sm" className="cursor-pointer text-destructive" disabled={!!busy} onClick={() => setConfirmLeave(true)}>
                    <LogOut className="w-4 h-4 mr-2" />
                    Leave team
                  </Button>
                </CardContent>
              </Card>
            )}

            {!account.isMember && !isPro && (
              <Card className="bg-card border-0 shadow-lg">
                <CardHeader className="p-4 sm:p-6 lg:p-8">
                  <CardTitle className="text-xl">Work on monitoring together</CardTitle>
                  <CardDescription>
                    On Pro you can invite up to 10 teammates. Editors can change checks, alerts and status pages. Viewers can see everything without changing anything. Each teammate signs in with their own login, and can use the API and MCP on your account.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8">
                  <Button asChild size="sm" className="cursor-pointer">
                    <Link to="/billing?plan=pro">Upgrade to Pro</Link>
                  </Button>
                </CardContent>
              </Card>
            )}

            {!account.isMember && isPro && team?.canManage && (
              <Card className="bg-card border-0 shadow-lg">
                <CardHeader className="p-4 sm:p-6 lg:p-8">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-xl">Invite a teammate</CardTitle>
                      <CardDescription>They'll get an email with a link. The invite works for 14 days.</CardDescription>
                    </div>
                    <Badge variant="outline">{team.seats.used} of {team.seats.total} seats used</Badge>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8">
                  <form onSubmit={sendInvite} className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <div className="flex-1 space-y-2">
                      <Label htmlFor="invite-email">Email</Label>
                      <Input
                        id="invite-email"
                        type="email"
                        placeholder="teammate@company.com"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        disabled={inviting || seatsFull}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="invite-role">Role</Label>
                      {/* Wrapped so Radix's hidden native select doesn't take a space-y gap and lift the field. */}
                      <div className="flex h-9 items-start">
                        <RoleSelect id="invite-role" value={inviteRole} onChange={setInviteRole} disabled={inviting || seatsFull} />
                      </div>
                    </div>
                    <Button type="submit" className="cursor-pointer" disabled={inviting || seatsFull || !inviteEmail.trim()}>
                      {inviting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <UserPlus className="w-4 h-4 mr-2" />}
                      Send invite
                    </Button>
                  </form>
                  <p className="mt-3 text-sm text-muted-foreground">
                    {seatsFull
                      ? 'All seats are taken. Remove a member or cancel an invite to make room.'
                      : `${ROLE_LABEL[inviteRole]}: ${ROLE_HINT[inviteRole].toLowerCase()}.`}
                  </p>
                </CardContent>
              </Card>
            )}

            {(account.isMember || isPro) && (
              <Card className="bg-card border-0 shadow-lg">
                <CardHeader className="p-4 sm:p-6 lg:p-8">
                  <CardTitle className="text-xl">Members</CardTitle>
                  <CardDescription>
                    {team?.canManage
                      ? 'People who can work in your account. Removing someone also switches off the API keys and agent connections they made here.'
                      : 'People who can work in this account.'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8 space-y-3">
                  {loadingTeam && !team && (
                    <div className="space-y-3">
                      <Skeleton className="h-14 w-full" />
                      <Skeleton className="h-14 w-full" />
                    </div>
                  )}
                  {teamError && (
                    <Alert variant="destructive">
                      <AlertDescription>{teamError}</AlertDescription>
                    </Alert>
                  )}
                  {team && team.members.length === 0 && (
                    <p className="text-sm text-muted-foreground">No teammates yet.</p>
                  )}
                  {team?.members.map((member) => {
                    const isMe = member.memberUid === account.actorUid;
                    return (
                      <div key={member.memberUid} className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <div className="font-medium truncate">
                            {member.name || member.email}
                            {isMe && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                          </div>
                          <div className="text-sm text-muted-foreground truncate">
                            {member.name ? `${member.email} · ` : ''}Joined {formatDate(member.joinedAt)}
                          </div>
                        </div>
                        {team.canManage ? (
                          <div className="flex items-center gap-2 shrink-0">
                            <RoleSelect
                              label={`Role for ${member.name || member.email}`}
                              value={member.role}
                              onChange={(role) => changeRole(member, role)}
                              disabled={!!busy}
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="cursor-pointer text-muted-foreground hover:text-destructive"
                              aria-label={`Remove ${member.email}`}
                              disabled={!!busy}
                              onClick={() => setConfirmRemove(member)}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        ) : (
                          <Badge variant="secondary" className="w-fit">{ROLE_LABEL[member.role]}</Badge>
                        )}
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            )}

            {team?.canManage && team.invites.length > 0 && (
              <Card className="bg-card border-0 shadow-lg">
                <CardHeader className="p-4 sm:p-6 lg:p-8">
                  <CardTitle className="text-xl">Pending invites</CardTitle>
                  <CardDescription>Waiting for these people to accept.</CardDescription>
                </CardHeader>
                <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8 space-y-3">
                  {team.invites.map((invite) => (
                    <div key={invite.id} className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="font-medium truncate flex items-center gap-2">
                          <Mail className="w-4 h-4 shrink-0 text-muted-foreground" />
                          <span className="truncate">{invite.email}</span>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {ROLE_LABEL[invite.role]} · Expires {formatDate(invite.expiresAt)}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 shrink-0">
                        <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => copyLink(invite.link)}>
                          <Copy className="w-4 h-4 mr-2" />
                          Copy link
                        </Button>
                        <Button variant="outline" size="sm" className="cursor-pointer" disabled={!!busy} onClick={() => resendInvite(invite)}>
                          <RefreshCw className={`w-4 h-4 mr-2 ${busy === `resend:${invite.id}` ? 'animate-spin' : ''}`} />
                          Resend
                        </Button>
                        <Button variant="ghost" size="sm" className="cursor-pointer text-muted-foreground hover:text-destructive" disabled={!!busy} onClick={() => revokeInvite(invite)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {otherTeams.length > 0 && (
              <Card className="bg-card border-0 shadow-lg">
                <CardHeader className="p-4 sm:p-6 lg:p-8">
                  <CardTitle className="text-xl">Teams you're in</CardTitle>
                  <CardDescription>Switch into a team's account to work on its monitoring.</CardDescription>
                </CardHeader>
                <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8 space-y-3">
                  {otherTeams.map((t) => (
                    <div key={t.accountId} className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{teamAccountLabel(t)}</div>
                        <div className="text-sm text-muted-foreground">
                          {t.active ? ROLE_LABEL[t.role] : 'Paused: the owner is no longer on Pro'}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="cursor-pointer shrink-0"
                        disabled={!t.active}
                        onClick={() => account.switchAccount(t.accountId)}
                      >
                        <ArrowRightLeft className="w-4 h-4 mr-2" />
                        Switch
                      </Button>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </PageContainer>

      <ConfirmationModal
        isOpen={!!confirmRemove}
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => confirmRemove && removeMember(confirmRemove)}
        title="Remove from team?"
        message={confirmRemove
          ? `${confirmRemove.name || confirmRemove.email} will lose access to your account right away. API keys and agent connections they made here stop working.`
          : ''}
        confirmText="Remove"
        variant="destructive"
      />
      <ConfirmationModal
        isOpen={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        onConfirm={leaveTeam}
        title="Leave this team?"
        message="You'll lose access to this account right away. API keys and agent connections you made in it stop working. The owner can invite you again."
        confirmText="Leave team"
        variant="destructive"
      />
    </>
  );
};

export default Team;
