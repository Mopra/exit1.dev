import React, { useState, useEffect } from 'react';
import { useUser, useClerk } from '@clerk/clerk-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  Input,
  Label,
  Badge,
  EmptyState,
  Alert,
  AlertDescription,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Avatar,
  AvatarImage,
  AvatarFallback,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '../components/ui';
import { User, CheckCircle, Save, AlertTriangle, Trash2, Link, Camera, Loader2, Plus, Unlink, Info } from 'lucide-react';
import { apiClient } from '../api/client';


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
  // Edit toggles removed in favor of always-on forms per modern UX
  const [isLoading, setIsLoading] = useState(false);
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
    setIsLoading(true);
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
      setIsLoading(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccess(null);

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setError('New passwords do not match');
      setIsLoading(false);
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
      setIsLoading(false);
    }
  };

  const handleDisconnectConnection = async () => {
    if (!connectionToDisconnect) return;
    
    setIsLoading(true);
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
      setIsLoading(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!user) return;

    setIsLoading(true);
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
      setIsLoading(false);
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
      <div className="grid gap-6 lg:gap-8 max-w-5xl mx-auto">
        {/* Header */}
        <Card className="bg-card border-0 shadow-lg">
          <CardHeader className="p-6 lg:p-8">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] items-center gap-4">
              <div>
                <CardTitle className="text-2xl lg:text-3xl">Profile</CardTitle>
                <CardDescription>Manage your account, security, and connected apps.</CardDescription>
              </div>
              <Button
                onClick={() => openUserProfile()}
                variant="secondary"
                size="sm"
                className="cursor-pointer"
              >
                <User className="w-4 h-4 mr-2" /> Manage account
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0 pb-6 lg:pb-8">
            <div className="flex items-center gap-4 lg:gap-6">
              <div className="relative">
                <Avatar className="h-16 w-16 lg:h-20 lg:w-20">
                  {user.imageUrl ? (
                    <AvatarImage src={user.imageUrl} alt="Profile" />
                  ) : (
                    <AvatarFallback className="font-semibold">
                      {getInitials(user.username || undefined, user.primaryEmailAddress?.emailAddress)}
                    </AvatarFallback>
                  )}
                </Avatar>
                <button
                  onClick={() => openUserProfile()}
                  className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-white text-black grid place-items-center shadow-sm hover:shadow cursor-pointer"
                >
                  <Camera className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-lg lg:text-xl font-semibold truncate">
                  {user.username || user.primaryEmailAddress?.emailAddress?.split('@')[0] || 'Welcome'}
                </div>
                <div className="text-muted-foreground text-sm truncate">
                  {user.primaryEmailAddress?.emailAddress}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant="success">Verified</Badge>
                <Badge variant="outline" className="gap-1">
                  <Link className="w-4 h-4" /> {user.externalAccounts.length}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Global messages */}
        {(error || success) && (
          <div>
            {error && (
              <Alert variant="destructive">
                <AlertTriangle className="w-4 h-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {success && (
              <Alert className="border-green-500/20 bg-green-500/10">
                <CheckCircle className="w-4 h-4 text-green-500" />
                <AlertDescription className="text-green-200">{success}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {/* Main */}
        <Card className="bg-card border-0 shadow-lg">
          <CardContent className="p-6 lg:p-8">
            <Tabs defaultValue="overview" className="w-full">
              <TabsList className="cursor-pointer">
                <TabsTrigger value="overview" className="cursor-pointer">Overview</TabsTrigger>
                <TabsTrigger value="account" className="cursor-pointer">Account</TabsTrigger>
                <TabsTrigger value="security" className="cursor-pointer">Security</TabsTrigger>
                <TabsTrigger value="connections" className="cursor-pointer">Connections</TabsTrigger>
                <TabsTrigger value="danger" className="cursor-pointer">Danger</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="mt-4">
                <div className="grid gap-4">
                  <div className="text-sm text-muted-foreground">
                    Welcome back. Manage your profile, password, and connected accounts.
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Badge variant="success" className="gap-1">
                      <CheckCircle className="w-4 h-4" /> Verified email
                    </Badge>
                    <Badge variant="outline" className="gap-1">
                      <Link className="w-4 h-4" /> {user.externalAccounts.length} connections
                    </Badge>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="account" className="mt-4">
                <div className="grid gap-6">
                  <div>
                    <div className="text-base font-medium">Profile information</div>
                    <div className="text-sm text-muted-foreground">Update your personal details.</div>
                  </div>
                  <form onSubmit={handleProfileUpdate} className="grid gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="username">Username</Label>
                      <Input
                        id="username"
                        value={profileForm.username}
                        onChange={(e) => setProfileForm((prev) => ({ ...prev, username: e.target.value }))}
                        placeholder="Enter your username"
                        className="transition-all duration-200 focus:scale-[1.01]"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="email">Email</Label>
                      <Input id="email" value={profileForm.email} disabled className="bg-muted/50" />
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Info className="w-3 h-3" /> Email changes require verification via account settings.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-3 pt-2">
                      <Button type="submit" disabled={isLoading} className="cursor-pointer">
                        {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                        {isLoading ? 'Saving…' : 'Save changes'}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
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

              <TabsContent value="security" className="mt-4">
                <div className="grid gap-6">
                  <div>
                    <div className="text-base font-medium">Password</div>
                    <div className="text-sm text-muted-foreground">Change your password regularly to keep your account secure.</div>
                  </div>
                  <form onSubmit={handlePasswordChange} className="grid gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="currentPassword">Current password</Label>
                      <Input
                        id="currentPassword"
                        type="password"
                        value={passwordForm.currentPassword}
                        onChange={(e) => setPasswordForm((prev) => ({ ...prev, currentPassword: e.target.value }))}
                        placeholder="Enter current password"
                        className="transition-all duration-200 focus:scale-[1.01]"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="newPassword">New password</Label>
                      <Input
                        id="newPassword"
                        type="password"
                        value={passwordForm.newPassword}
                        onChange={(e) => setPasswordForm((prev) => ({ ...prev, newPassword: e.target.value }))}
                        placeholder="Enter new password"
                        className="transition-all duration-200 focus:scale-[1.01]"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="confirmPassword">Confirm new password</Label>
                      <Input
                        id="confirmPassword"
                        type="password"
                        value={passwordForm.confirmPassword}
                        onChange={(e) => setPasswordForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
                        placeholder="Confirm new password"
                        className="transition-all duration-200 focus:scale-[1.01]"
                      />
                    </div>
                    <div className="flex flex-wrap gap-3 pt-2">
                      <Button type="submit" disabled={isLoading} size="sm" className="cursor-pointer">
                        {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                        Update password
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
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

              <TabsContent value="connections" className="mt-4">
                <div className="grid gap-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-base font-medium">Connected accounts</div>
                      <div className="text-sm text-muted-foreground">Manage social logins and integrations.</div>
                    </div>
                    <Button variant="secondary" onClick={() => openUserProfile()} className="cursor-pointer">
                      <Plus className="w-4 h-4 mr-2" /> Add connection
                    </Button>
                  </div>
                  {user.externalAccounts.length > 0 ? (
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {user.externalAccounts.map((account) => (
                        <div
                          key={account.id}
                          className="group relative p-4 rounded-lg border bg-background/40 backdrop-blur transition-all hover:bg-background/60 cursor-pointer"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-muted grid place-items-center">
                              <div className="text-xs font-medium">
                                {getConnectionIcon(account.verification?.strategy || '') === 'google' && 'G'}
                                {getConnectionIcon(account.verification?.strategy || '') === 'github' && 'GH'}
                                {getConnectionIcon(account.verification?.strategy || '') === 'discord' && 'D'}
                                {getConnectionIcon(account.verification?.strategy || '') === 'link' && (
                                  <Link className="w-4 h-4" />
                                )}
                              </div>
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-medium truncate">
                                {getConnectionName(account.verification?.strategy || '')}
                              </div>
                              <div className="text-xs text-muted-foreground truncate">{account.emailAddress}</div>
                            </div>
                            <div className="ml-auto">
                              <Badge variant="success" className="text-xs">Connected</Badge>
                            </div>
                          </div>
                          <div className="mt-3 flex justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConnectionToDisconnect(account.id);
                                setShowDisconnectModal(true);
                              }}
                              className="text-red-500 hover:text-red-400 cursor-pointer"
                            >
                              <Unlink className="w-4 h-4 mr-1" /> Disconnect
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      icon={Link}
                      title="No Connected Accounts"
                      description="Connect your favorite services to sign in faster and sync your data across platforms"
                      action={{ label: 'Connect Your First Account', onClick: () => openUserProfile(), icon: Plus }}
                    />
                  )}
                </div>
              </TabsContent>

              <TabsContent value="danger" className="mt-4">
                <div className="grid gap-4">
                  <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-sm font-medium">Delete account</div>
                        <div className="text-xs text-muted-foreground">
                          Permanently delete your account and all associated data. This action cannot be undone.
                        </div>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setShowDeleteAccountModal(true)}
                        className="cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4 mr-2" /> Delete
                      </Button>
                    </div>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>

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
            <DialogTitle>Disconnect Account</DialogTitle>
          </DialogHeader>
          <div className="grid gap-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-red-500/20 grid place-items-center">
                <AlertTriangle className="w-6 h-6 text-red-400" />
              </div>
              <div>
                <h3 className={`text-foreground font-mono text-lg font-medium mb-1`}>
                  Disconnect Account?
                </h3>
                <p className={`text-sm text-muted-foreground`}>
                  This action cannot be undone
                </p>
              </div>
            </div>

            <p className={`text-muted-foreground font-mono text-sm`}>
              Are you sure you want to disconnect this account? You won't be able to sign in with it anymore,
              and you'll need to reconnect it if you want to use it again.
            </p>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowDisconnectModal(false);
                  setConnectionToDisconnect(null);
                }}
                className="cursor-pointer"
              >
                Keep Connected
              </Button>
              <Button
                variant="destructive"
                onClick={handleDisconnectConnection}
                disabled={isLoading}
                className="cursor-pointer"
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Unlink className="w-4 h-4 mr-2" />}
                {isLoading ? 'Disconnecting…' : 'Disconnect Account'}
              </Button>
            </div>
          </div>
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
            <DialogTitle>Delete Account</DialogTitle>
          </DialogHeader>
          <div className="grid gap-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-red-500/20 grid place-items-center">
                <Trash2 className="w-6 h-6 text-red-400" />
              </div>
              <div>
                <h3 className={`text-foreground font-mono text-lg font-medium mb-1`}>
                  Delete Account?
                </h3>
                <p className={`text-sm text-muted-foreground`}>
                  This action cannot be undone. All your data will be permanently deleted.
                </p>
              </div>
            </div>

            <p className={`text-muted-foreground font-mono text-sm`}>
              Are you absolutely sure you want to delete your account? This will permanently delete your account and all associated data.
            </p>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <Button
                variant="ghost"
                onClick={() => setShowDeleteAccountModal(false)}
                className="cursor-pointer"
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDeleteAccount}
                disabled={isLoading}
                className="cursor-pointer"
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
                {isLoading ? 'Deleting…' : 'Delete Account'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default Profile; 