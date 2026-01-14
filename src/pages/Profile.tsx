import React, { useState, useEffect } from 'react';
import { useUser, useClerk } from '@clerk/clerk-react';
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
import { User, CheckCircle, Save, AlertTriangle, Trash2, Link as LinkIcon, Camera, Loader2, Plus, Unlink, Info, Sparkles, Shield } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiClient } from '../api/client';
import { useNanoPlan } from "@/hooks/useNanoPlan"


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
  const { nano } = useNanoPlan()

  
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
              variant="outline"
              size="sm"
              className="cursor-pointer"
            >
              <User className="w-4 h-4 mr-2" /> Manage account in Clerk
            </Button>
          }
        />

        <div className="flex-1 overflow-auto w-full">
          <div className="w-full mx-auto">
          <div className="grid gap-6 lg:gap-8 w-full">
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
                      <LinkIcon className="w-3.5 h-3.5" /> {connectionsCount} {connectionLabel}
                    </Badge>
                    {nano && (
                      <Link to="/billing" className="cursor-pointer">
                        <Badge variant="secondary" className="gap-1 drop-shadow-[0_0_8px_rgba(252,211,77,0.45)] text-amber-300/95 bg-amber-400/10 border-amber-300/20 hover:bg-amber-400/20 hover:border-amber-300/30 transition-colors">
                          <Sparkles className="w-3.5 h-3.5 drop-shadow-[0_0_8px_rgba(252,211,77,0.55)] text-amber-300/95" /> Nano
                        </Badge>
                      </Link>
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

            <Card className="bg-card border-0 shadow-lg p-2">
              <CardHeader>
                <CardTitle className="text-xl">Settings</CardTitle>
                <CardDescription>Update your account details, security, and connected apps.</CardDescription>
              </CardHeader>
              <CardContent className="pt-0 pb-6 lg:pb-8">
                <Tabs defaultValue="account" className="w-full">
                  <TabsList className="w-full sm:w-fit">
                    <TabsTrigger value="account" className="cursor-pointer min-w-0 sm:min-w-[5.5rem] px-2 sm:px-3 touch-manipulation">
                      <User className="w-4 h-4 flex-shrink-0" />
                      <span className="hidden sm:inline">Account</span>
                    </TabsTrigger>
                    <TabsTrigger value="security" className="cursor-pointer min-w-0 sm:min-w-[5.5rem] px-2 sm:px-3 touch-manipulation">
                      <Shield className="w-4 h-4 flex-shrink-0" />
                      <span className="hidden sm:inline">Security</span>
                    </TabsTrigger>
                    <TabsTrigger value="connections" className="cursor-pointer min-w-0 sm:min-w-[5.5rem] px-2 sm:px-3 touch-manipulation">
                      <LinkIcon className="w-4 h-4 flex-shrink-0" />
                      <span className="hidden sm:inline">Connections</span>
                    </TabsTrigger>
                    <TabsTrigger value="danger" className="cursor-pointer min-w-0 sm:min-w-[5.5rem] px-2 sm:px-3 touch-manipulation">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                      <span className="hidden sm:inline">Danger</span>
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="account" className="mt-8 space-y-6">
                    <div className="space-y-6">
                      <div>
                        <h3 className="text-base font-semibold mb-1">Profile Information</h3>
                        <p className="text-sm text-muted-foreground">
                          Update your account details and personal information.
                        </p>
                      </div>
                      
                      <form onSubmit={handleProfileUpdate} className="space-y-6">
                        <div className="space-y-4">
                          <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label htmlFor="username" className="text-sm font-medium">Username</Label>
                              <Input
                                id="username"
                                value={profileForm.username}
                                onChange={(e) =>
                                  setProfileForm((prev) => ({ ...prev, username: e.target.value }))
                                }
                                placeholder="Enter your username"
                                autoComplete="username"
                                className="h-10"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="email" className="text-sm font-medium">Email Address</Label>
                              <Input
                                id="email"
                                value={profileForm.email}
                                disabled
                                className="bg-muted/50 h-10"
                                autoComplete="email"
                              />
                            </div>
                          </div>
                          
                          <div className="rounded-md bg-muted/30 border border-border/50 p-3">
                            <p className="text-xs text-muted-foreground flex items-start gap-2">
                              <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> 
                              <span>
                                To change your email address,{' '}
                                <button
                                  type="button"
                                  onClick={() => openUserProfile()}
                                  className="text-primary hover:underline cursor-pointer font-medium inline"
                                >
                                  open account settings
                                </button>
                                {' '}in Clerk.
                              </span>
                            </p>
                          </div>
                        </div>
                        
                        <Separator />
                        
                        <div className="flex flex-wrap items-center gap-3">
                          <Button
                            type="submit"
                            disabled={isSavingProfile}
                            variant="default"
                            size="default"
                            className="cursor-pointer"
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
                            size="default"
                            disabled={isSavingProfile}
                            onClick={() => {
                              setProfileForm({
                                email: user.primaryEmailAddress?.emailAddress || '',
                                username: user.username || '',
                              });
                            }}
                            className="cursor-pointer"
                          >
                            Reset
                          </Button>
                        </div>
                      </form>
                    </div>
                  </TabsContent>

                  <TabsContent value="security" className="mt-8 space-y-6">
                    <div className="space-y-6">
                      <div>
                        <h3 className="text-base font-semibold mb-1">Change Password</h3>
                        <p className="text-sm text-muted-foreground">
                          Update your password to keep your account secure. Use a long, unique password.
                        </p>
                      </div>
                      
                      <form onSubmit={handlePasswordChange} className="space-y-6">
                        <div className="space-y-4">
                          <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label htmlFor="currentPassword" className="text-sm font-medium">Current Password</Label>
                              <Input
                                id="currentPassword"
                                type="password"
                                value={passwordForm.currentPassword}
                                onChange={(e) =>
                                  setPasswordForm((prev) => ({ ...prev, currentPassword: e.target.value }))
                                }
                                placeholder="Enter current password"
                                autoComplete="current-password"
                                className="h-10"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="newPassword" className="text-sm font-medium">New Password</Label>
                              <Input
                                id="newPassword"
                                type="password"
                                value={passwordForm.newPassword}
                                onChange={(e) =>
                                  setPasswordForm((prev) => ({ ...prev, newPassword: e.target.value }))
                                }
                                placeholder="Enter new password"
                                autoComplete="new-password"
                                className="h-10"
                              />
                            </div>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="confirmPassword" className="text-sm font-medium">Confirm New Password</Label>
                            <Input
                              id="confirmPassword"
                              type="password"
                              value={passwordForm.confirmPassword}
                              onChange={(e) =>
                                setPasswordForm((prev) => ({ ...prev, confirmPassword: e.target.value }))
                              }
                              placeholder="Confirm new password"
                              autoComplete="new-password"
                              className="h-10"
                            />
                          </div>
                        </div>
                        
                        <Separator />
                        
                        <div className="flex flex-wrap items-center gap-3">
                          <Button
                            type="submit"
                            disabled={isChangingPassword}
                            variant="default"
                            size="default"
                            className="cursor-pointer"
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
                            size="default"
                            disabled={isChangingPassword}
                            onClick={() =>
                              setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
                            }
                            className="cursor-pointer"
                          >
                            Reset
                          </Button>
                        </div>
                      </form>
                    </div>
                  </TabsContent>

                  <TabsContent value="connections" className="mt-8 space-y-6">
                    <div className="space-y-6">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <h3 className="text-base font-semibold mb-1">Connected Accounts</h3>
                          <p className="text-sm text-muted-foreground">
                            Link your accounts to speed up sign-in and keep access methods in sync.
                          </p>
                        </div>
                        <Button
                          variant="default"
                          size="default"
                          onClick={() => openUserProfile()}
                          className="cursor-pointer"
                        >
                          <Plus className="w-4 h-4 mr-2" /> Add connection
                        </Button>
                      </div>
                      
                      {user.externalAccounts.length > 0 ? (
                        <div className="space-y-3">
                          {user.externalAccounts.map((account) => {
                            const connectionIcon = getConnectionIcon(account.verification?.strategy || '');
                            return (
                              <div
                                key={account.id}
                                className="rounded-lg border bg-background/40 p-4 transition-colors hover:bg-background/60"
                              >
                                <div className="flex items-start gap-4">
                                  <Avatar className="h-10 w-10">
                                    <AvatarFallback className="text-sm font-medium">
                                      {connectionIcon === 'google' && 'G'}
                                      {connectionIcon === 'github' && 'GH'}
                                      {connectionIcon === 'discord' && 'D'}
                                      {connectionIcon === 'link' && <LinkIcon className="w-5 h-5" />}
                                    </AvatarFallback>
                                  </Avatar>
                                  <div className="min-w-0 flex-1 space-y-1">
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
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={isDisconnecting}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setConnectionToDisconnect(account.id);
                                      setShowDisconnectModal(true);
                                    }}
                                    className="text-destructive hover:text-destructive/80 hover:bg-destructive/10 cursor-pointer"
                                  >
                                    <Unlink className="w-4 h-4 mr-1.5" /> Disconnect
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <EmptyState
                          className="m-0"
                          icon={LinkIcon}
                          title="No connected accounts"
                          description="Connect your favorite services to sign in faster and keep your account synced."
                          action={{ label: 'Connect account', onClick: () => openUserProfile(), icon: Plus }}
                        />
                      )}
                    </div>
                  </TabsContent>

                  <TabsContent value="danger" className="mt-8 space-y-6">
                    <div className="space-y-6">
                      <div>
                        <h3 className="text-base font-semibold mb-1 text-destructive">Danger Zone</h3>
                        <p className="text-sm text-muted-foreground">
                          Irreversible and destructive actions for your account.
                        </p>
                      </div>
                      
                      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 space-y-4">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                          <div className="space-y-1">
                            <div className="text-sm font-semibold text-destructive">Delete Account</div>
                            <div className="text-sm text-muted-foreground">
                              Permanently delete your account and all associated data. This action cannot be undone.
                            </div>
                          </div>
                          <DeleteButton
                            size="default"
                            onClick={() => setShowDeleteAccountModal(true)}
                            className="cursor-pointer"
                          >
                            Delete account
                          </DeleteButton>
                        </div>
                        <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3">
                          <p className="text-xs text-muted-foreground flex items-start gap-2">
                            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-destructive" />
                            <span>
                              Once you delete your account, there is no going back. Please be certain. 
                              Make sure to export any data you want to keep before proceeding.
                            </span>
                          </p>
                        </div>
                      </div>
                    </div>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>
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
