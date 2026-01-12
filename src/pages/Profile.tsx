import React, { useState, useEffect } from 'react';
import { useUser, useClerk } from '@clerk/clerk-react';
import { useSubscription } from "@clerk/clerk-react/experimental"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  DeleteButton,
  Input,
  Label,
  Badge,
  EmptyState,
  Alert,
  AlertDescription,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Avatar,
  AvatarImage,
  AvatarFallback,
  Separator,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../components/ui';
import { PageHeader, PageContainer } from '../components/layout';
import { User, CheckCircle, Save, AlertTriangle, Trash2, Link, Camera, Loader2, Plus, Unlink, Info, Sparkles, Shield } from 'lucide-react';
import { apiClient } from '../api/client';
import { isNanoPlan } from "@/lib/subscription"


interface ProfileFormData {
  email: string;
  username: string;
}

interface PasswordFormData {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

const Profile: React.FC = () => {
  const { user } = useUser();
  const { openUserProfile } = useClerk();
  const { data: subscription } = useSubscription()
  const nano = isNanoPlan(subscription ?? null)

  
  // Form states
  const [profileForm, setProfileForm] = useState<ProfileFormData>({
    email: '',
    username: ''
  });
  const [passwordForm, setPasswordForm] = useState<PasswordFormData>({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  
  // UI states
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);
  const [connectionToDisconnect, setConnectionToDisconnect] = useState<string | null>(null);
  const [showDeleteAccountModal, setShowDeleteAccountModal] = useState(false);

  // Load user data on component mount
  useEffect(() => {
    if (user) {
      setProfileForm({
        email: user.primaryEmailAddress?.emailAddress || '',
        username: user.username || ''
      });
    }
  }, [user]);

  // Clear messages after 5 seconds
  useEffect(() => {
    if (error || success) {
      const timer = setTimeout(() => {
        setError(null);
        setSuccess(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [error, success]);

  const handleProfileUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingProfile(true);
    setError(null);
    setSuccess(null);

    try {
      await user?.update({
        username: profileForm.username
      });

      setSuccess('Profile updated successfully!');
    } catch (err: any) {
      setError(err.errors?.[0]?.message || 'Failed to update profile');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsChangingPassword(true);
    setError(null);
    setSuccess(null);

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setError('New passwords do not match');
      setIsChangingPassword(false);
      return;
    }

    try {
      await user?.updatePassword({
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword
      });

      setSuccess('Password changed successfully!');
      setPasswordForm({
        currentPassword: '',
        newPassword: '',
        confirmPassword: ''
      });
    } catch (err: any) {
      setError(err.errors?.[0]?.message || 'Failed to change password');
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleDisconnectConnection = async () => {
    if (!connectionToDisconnect) return;
    
    setIsDisconnecting(true);
    setError(null);
    setSuccess(null);

    try {
      const externalAccount = user?.externalAccounts.find(acc => acc.id === connectionToDisconnect);
      if (externalAccount) {
        await externalAccount.destroy();
        setSuccess('Connection disconnected successfully!');
        setShowDisconnectModal(false);
        setConnectionToDisconnect(null);
      } else {
        setError('Connection not found');
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.message || 'Failed to disconnect account');
    } finally {
      setIsDisconnecting(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!user) return;

    setIsDeleting(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await apiClient.deleteUserAccount();
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete user data');
      }

      await user.delete();
      
      setSuccess('Account deleted successfully!');
      setShowDeleteAccountModal(false);
    } catch (err: any) {
      setError(err.message || 'Failed to delete account');
    } finally {
      setIsDeleting(false);
    }
  };

  const getConnectionIcon = (strategy: string) => {
    switch (strategy) {
      case 'oauth_google':
        return 'google';
      case 'oauth_github':
        return 'github';
      case 'oauth_discord':
        return 'discord';
      default:
        return 'link';
    }
  };



  const getConnectionName = (strategy: string) => {
    switch (strategy) {
      case 'oauth_google':
        return 'Google';
      case 'oauth_github':
        return 'GitHub';
      case 'oauth_discord':
        return 'Discord';
      default:
        return strategy;
    }
  };

  const getInitials = (username?: string, email?: string) => {
    if (username && username.length >= 2) {
      return username.slice(0, 2).toUpperCase();
    }
    if (email) {
      const emailName = email.split('@')[0];
      if (emailName.length >= 2) {
        return emailName.slice(0, 2).toUpperCase();
      }
      return email[0].toUpperCase();
    }
    return 'U';
  };

  const emailAddress = user?.primaryEmailAddress?.emailAddress || '';
  const displayName = user?.username || emailAddress.split('@')[0] || 'Welcome';
  const emailVerified = user?.primaryEmailAddress?.verification?.status === 'verified';
  const connectionsCount = user?.externalAccounts.length ?? 0;
  const connectionLabel = connectionsCount === 1 ? 'connection' : 'connections';
  const emailStatusLabel = emailVerified ? 'Email verified' : 'Email not verified';

  if (!user) {
    return (
      <div className="grid place-items-center min-h-[600px]">
        <div className="text-center space-y-4">
          <div className="animate-pulse">
            <div className="w-24 h-24 bg-white/10 rounded-full mx-auto mb-4"></div>
            <div className="h-4 bg-white/10 rounded w-32 mx-auto mb-2"></div>
            <div className="h-3 bg-white/5 rounded w-48 mx-auto"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <PageContainer>
        <PageHeader 
          title="Profile" 
          description="Manage your account, security, and connected apps"
          icon={User}
          actions={
            <Button
              onClick={() => openUserProfile()}
              variant="default"
              size="sm"
              className="cursor-pointer"
            >
              <User className="w-4 h-4 mr-2" /> Manage account
            </Button>
          }
        />

        <div className="flex-1 overflow-auto -mx-4 sm:-mx-6 lg:-mx-12 px-4 sm:px-6 lg:px-12">
          <div className="max-w-5xl mx-auto grid gap-6 lg:gap-8 w-full">
            <Card className="bg-card border-0 shadow-lg">
              <CardContent className="pt-6 pb-6 lg:pb-8">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="relative">
                      <Avatar className="h-16 w-16 lg:h-20 lg:w-20">
                        {user.imageUrl ? (
                          <AvatarImage src={user.imageUrl} alt="Profile" />
                        ) : (
                          <AvatarFallback className="font-semibold">
                            {getInitials(user.username || undefined, emailAddress)}
                          </AvatarFallback>
                        )}
                      </Avatar>
                      <Button
                        onClick={() => openUserProfile()}
                        size="icon"
                        variant="secondary"
                        className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full shadow-sm cursor-pointer"
                        aria-label="Change profile image"
                      >
                        <Camera className="w-4 h-4" />
                      </Button>
                    </div>
                    <div className="min-w-0">
                      <div className="text-lg lg:text-xl font-semibold truncate">
                        {displayName}
                      </div>
                      <div className="text-muted-foreground text-sm truncate">
                        {emailAddress}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto sm:justify-end">
                    <Badge
                      variant={emailVerified ? "success" : "outline"}
                      className={`gap-1 ${emailVerified ? "" : "border-amber-400/40 text-amber-500"}`}
                    >
                      {emailVerified ? (
                        <CheckCircle className="w-3.5 h-3.5" />
                      ) : (
                        <AlertTriangle className="w-3.5 h-3.5" />
                      )}
                      {emailStatusLabel}
                    </Badge>
                    <Badge variant="outline" className="gap-1">
                      <Link className="w-3.5 h-3.5" /> {connectionsCount} {connectionLabel}
                    </Badge>
                    {nano && (
                      <Badge variant="secondary" className="gap-1">
                        <Sparkles className="w-3.5 h-3.5" /> Nano
                      </Badge>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {(error || success) && (
              <div className="space-y-2">
                {error && (
                  <Alert variant="destructive">
                    <AlertTriangle className="w-4 h-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                {success && (
                  <Alert className="border-primary/20 bg-primary/10">
                    <CheckCircle className="w-4 h-4 text-primary" />
                    <AlertDescription className="text-primary">{success}</AlertDescription>
                  </Alert>
                )}
              </div>
            )}

            <Card className="bg-card border-0 shadow-lg">
              <CardHeader className="p-6 lg:p-8">
                <CardTitle className="text-xl">Settings</CardTitle>
                <CardDescription>Update your account details, security, and connected apps.</CardDescription>
              </CardHeader>
              <CardContent className="pt-0 pb-6 lg:pb-8">
                <Tabs defaultValue="account" className="w-full">
                  <TabsList className="w-full sm:w-fit">
                    <TabsTrigger value="account" className="cursor-pointer">
                      <User className="w-4 h-4" />
                      <span>Account</span>
                    </TabsTrigger>
                    <TabsTrigger value="security" className="cursor-pointer">
                      <Shield className="w-4 h-4" />
                      <span>Security</span>
                    </TabsTrigger>
                    <TabsTrigger value="connections" className="cursor-pointer">
                      <Link className="w-4 h-4" />
                      <span>Connections</span>
                    </TabsTrigger>
                    <TabsTrigger value="danger" className="cursor-pointer">
                      <AlertTriangle className="w-4 h-4" />
                      <span>Danger</span>
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="account" className="mt-6">
                    <div className="rounded-lg border bg-background/40 p-4 sm:p-6">
                      <div className="space-y-1">
                        <h3 className="text-sm font-medium">Profile details</h3>
                        <p className="text-xs text-muted-foreground">
                          Update your username and review the email tied to your account.
                        </p>
                      </div>
                      <Separator className="my-4" />
                      <form onSubmit={handleProfileUpdate} className="grid gap-4">
                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="grid gap-2">
                            <Label htmlFor="username">Username</Label>
                            <Input
                              id="username"
                              value={profileForm.username}
                              onChange={(e) =>
                                setProfileForm((prev) => ({ ...prev, username: e.target.value }))
                              }
                              placeholder="Enter your username"
                              autoComplete="username"
                            />
                          </div>
                          <div className="grid gap-2">
                            <Label htmlFor="email">Email</Label>
                            <Input
                              id="email"
                              value={profileForm.email}
                              disabled
                              className="bg-muted/50"
                              autoComplete="email"
                            />
                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                              <Info className="w-3 h-3" /> Email changes require verification via account settings.
                            </p>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-3 pt-2">
                          <Button
                            type="submit"
                            disabled={isSavingProfile}
                            variant="default"
                            className="cursor-pointer w-full sm:w-auto"
                          >
                            {isSavingProfile ? (
                              <Loader2 className="w-4 h-4 animate-spin mr-2" />
                            ) : (
                              <Save className="w-4 h-4 mr-2" />
                            )}
                            {isSavingProfile ? 'Saving...' : 'Save changes'}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={isSavingProfile}
                            onClick={() => {
                              setProfileForm({
                                email: user.primaryEmailAddress?.emailAddress || '',
                                username: user.username || '',
                              });
                            }}
                            className="cursor-pointer text-muted-foreground hover:text-foreground hover:bg-muted w-full sm:w-auto"
                          >
                            Reset
                          </Button>
                        </div>
                      </form>
                    </div>
                  </TabsContent>

                  <TabsContent value="security" className="mt-6">
                    <div className="rounded-lg border bg-background/40 p-4 sm:p-6">
                      <div className="space-y-1">
                        <h3 className="text-sm font-medium">Password</h3>
                        <p className="text-xs text-muted-foreground">
                          Use a long, unique password to keep your account secure.
                        </p>
                      </div>
                      <Separator className="my-4" />
                      <form onSubmit={handlePasswordChange} className="grid gap-4">
                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="grid gap-2">
                            <Label htmlFor="currentPassword">Current password</Label>
                            <Input
                              id="currentPassword"
                              type="password"
                              value={passwordForm.currentPassword}
                              onChange={(e) =>
                                setPasswordForm((prev) => ({ ...prev, currentPassword: e.target.value }))
                              }
                              placeholder="Enter current password"
                              autoComplete="current-password"
                            />
                          </div>
                          <div className="grid gap-2">
                            <Label htmlFor="newPassword">New password</Label>
                            <Input
                              id="newPassword"
                              type="password"
                              value={passwordForm.newPassword}
                              onChange={(e) =>
                                setPasswordForm((prev) => ({ ...prev, newPassword: e.target.value }))
                              }
                              placeholder="Enter new password"
                              autoComplete="new-password"
                            />
                          </div>
                          <div className="grid gap-2 md:col-span-2">
                            <Label htmlFor="confirmPassword">Confirm new password</Label>
                            <Input
                              id="confirmPassword"
                              type="password"
                              value={passwordForm.confirmPassword}
                              onChange={(e) =>
                                setPasswordForm((prev) => ({ ...prev, confirmPassword: e.target.value }))
                              }
                              placeholder="Confirm new password"
                              autoComplete="new-password"
                            />
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-3 pt-2">
                          <Button
                            type="submit"
                            disabled={isChangingPassword}
                            variant="default"
                            size="sm"
                            className="cursor-pointer w-full sm:w-auto"
                          >
                            {isChangingPassword ? (
                              <Loader2 className="w-4 h-4 animate-spin mr-2" />
                            ) : (
                              <Save className="w-4 h-4 mr-2" />
                            )}
                            {isChangingPassword ? 'Updating...' : 'Update password'}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={isChangingPassword}
                            onClick={() =>
                              setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
                            }
                            className="cursor-pointer text-muted-foreground hover:text-foreground hover:bg-muted w-full sm:w-auto"
                          >
                            Reset
                          </Button>
                        </div>
                      </form>
                    </div>
                  </TabsContent>

                  <TabsContent value="connections" className="mt-6">
                    <div className="rounded-lg border bg-background/40 p-4 sm:p-6 space-y-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-medium">Connected apps</h3>
                          <p className="text-xs text-muted-foreground">
                            Link accounts to speed up sign-in and keep access methods in sync.
                          </p>
                        </div>
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => openUserProfile()}
                          className="cursor-pointer w-full sm:w-auto"
                        >
                          <Plus className="w-4 h-4 mr-2" /> Add connection
                        </Button>
                      </div>
                      {user.externalAccounts.length > 0 ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                          {user.externalAccounts.map((account) => {
                            const connectionIcon = getConnectionIcon(account.verification?.strategy || '');
                            return (
                              <div
                                key={account.id}
                                className="rounded-lg border bg-background/60 p-4 transition-colors hover:bg-background/80"
                              >
                                <div className="flex items-start gap-3">
                                  <Avatar className="h-9 w-9">
                                    <AvatarFallback className="text-xs font-medium">
                                      {connectionIcon === 'google' && 'G'}
                                      {connectionIcon === 'github' && 'GH'}
                                      {connectionIcon === 'discord' && 'D'}
                                      {connectionIcon === 'link' && <Link className="w-4 h-4" />}
                                    </AvatarFallback>
                                  </Avatar>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <p className="text-sm font-medium">
                                        {getConnectionName(account.verification?.strategy || '')}
                                      </p>
                                      <Badge variant="success" className="text-xs">Connected</Badge>
                                    </div>
                                    <p className="text-xs text-muted-foreground break-all">
                                      {account.emailAddress}
                                    </p>
                                  </div>
                                </div>
                                <div className="mt-3 flex">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={isDisconnecting}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setConnectionToDisconnect(account.id);
                                      setShowDisconnectModal(true);
                                    }}
                                    className="text-red-500 hover:text-red-400 cursor-pointer w-full sm:w-auto"
                                  >
                                    <Unlink className="w-4 h-4 mr-1" /> Disconnect
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <EmptyState
                          className="m-0"
                          icon={Link}
                          title="No connected accounts"
                          description="Connect your favorite services to sign in faster and keep your account synced."
                          action={{ label: 'Connect account', onClick: () => openUserProfile(), icon: Plus }}
                        />
                      )}
                    </div>
                  </TabsContent>

                  <TabsContent value="danger" className="mt-6">
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 sm:p-6 space-y-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="text-sm font-medium text-destructive">Delete account</div>
                          <div className="text-xs text-muted-foreground">
                            Permanently delete your account and all associated data.
                          </div>
                        </div>
                        <DeleteButton
                          size="sm"
                          onClick={() => setShowDeleteAccountModal(true)}
                          className="cursor-pointer w-full sm:w-auto"
                        >
                          Delete account
                        </DeleteButton>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        This action cannot be undone. Export anything you need before deleting your account.
                      </p>
                    </div>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>
        </div>
      </PageContainer>

      {/* Disconnect Modal */}
      <Dialog
        open={showDisconnectModal}
        onOpenChange={(open) => {
          if (!open) {
            setShowDisconnectModal(false);
            setConnectionToDisconnect(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect account</DialogTitle>
            <DialogDescription>
              Remove this sign-in method from your profile. You can reconnect it anytime.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-muted-foreground">
            <AlertTriangle className="w-4 h-4 text-destructive mt-0.5" />
            <span>You'll need another sign-in method to access your account.</span>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setShowDisconnectModal(false);
                setConnectionToDisconnect(null);
              }}
              disabled={isDisconnecting}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDisconnectConnection}
              disabled={isDisconnecting}
              className="cursor-pointer"
            >
              {isDisconnecting ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Unlink className="w-4 h-4 mr-2" />
              )}
              {isDisconnecting ? 'Disconnecting...' : 'Disconnect account'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Account Modal */}
      <Dialog
        open={showDeleteAccountModal}
        onOpenChange={(open) => {
          if (!open) {
            setShowDeleteAccountModal(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete account</DialogTitle>
            <DialogDescription>
              Permanently delete your account and all associated data.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-muted-foreground">
            <Trash2 className="w-4 h-4 text-destructive mt-0.5" />
            <span>This action cannot be undone.</span>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteAccountModal(false)}
              disabled={isDeleting}
              className="cursor-pointer text-muted-foreground hover:text-foreground"
            >
              Cancel
            </Button>
            <DeleteButton
              onClick={handleDeleteAccount}
              isLoading={isDeleting}
              className="cursor-pointer"
            >
              Delete account
            </DeleteButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default Profile; 
