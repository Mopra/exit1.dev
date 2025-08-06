import React, { useState, useEffect } from 'react';
import { useUser, useClerk } from '@clerk/clerk-react';
import { Card, Button, Input, Label, Badge, Separator, EmptyState, Alert, AlertDescription, Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui';
import { theme, typography } from '../config/theme';
import { User, CheckCircle, Edit, Save, AlertTriangle, Trash2, Key, Link, Camera, Loader2, Plus, Unlink, Info } from 'lucide-react';
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
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
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
      setIsEditingProfile(false);
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
      setIsChangingPassword(false);
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
      {/* Main Profile Container */}
      <div className="grid gap-6 lg:gap-8 max-w-4xl mx-auto">
        {/* Header Section */}
        <Card className={`${theme.colors.background.card} ${theme.shadows.glass} border-0`}>
          <div className="p-6 lg:p-8">
            <div className="grid gap-6">
              {/* Title and Actions */}
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4 items-center">
                <h1 className={`text-2xl lg:text-3xl uppercase tracking-widest ${typography.fontFamily.display} ${theme.colors.text.primary}`}>
                  Profile
                </h1>
                <Button
                  onClick={() => openUserProfile()}
                  variant="default"
                  size="sm"
                  className="w-full lg:w-auto cursor-pointer flex items-center gap-2"
                >
                  <User className="w-3 h-3" />
                  <span>Account Settings</span>
                </Button>
              </div>

              {/* User Info */}
              <div className="grid grid-cols-1 lg:grid-cols-[auto_1fr_auto] gap-4 lg:gap-6 items-center">
                {/* Avatar */}
                <div className="relative group justify-self-center lg:justify-self-start">
                  <div className="w-16 h-16 lg:w-20 lg:h-20 rounded-full bg-gradient-to-br from-white/20 to-white/5 backdrop-blur-xl border border-white/10 grid place-items-center text-lg lg:text-xl font-bold text-white shadow-2xl transition-all duration-300 group-hover:shadow-[0_0_40px_rgba(255,255,255,0.15)] group-hover:scale-105">
                    {user.imageUrl ? (
                      <img 
                        src={user.imageUrl} 
                        alt="Profile" 
                        className="w-full h-full rounded-full object-cover"
                      />
                    ) : (
                      getInitials(user.username || undefined, user.primaryEmailAddress?.emailAddress)
                    )}
                  </div>
                  <button 
                    onClick={() => openUserProfile()}
                    className="absolute -bottom-1 -right-1 w-6 h-6 lg:w-8 lg:h-8 bg-white/90 hover:bg-white rounded-full grid place-items-center transition-all duration-200 hover:scale-110 shadow-lg cursor-pointer"
                  >
                    <Camera className="w-3 h-3 text-black" />
                  </button>
                </div>

                {/* User Details */}
                <div className="text-center lg:text-left">
                  <h2 className={`text-xl lg:text-2xl font-bold tracking-tight ${theme.colors.text.primary} ${typography.fontFamily.display} mb-1`}>
                    {user.username || user.primaryEmailAddress?.emailAddress?.split('@')[0] || 'Welcome'}
                  </h2>
                  <p className={`${theme.colors.text.secondary} ${typography.fontFamily.mono} text-sm lg:text-base`}>
                    {user.primaryEmailAddress?.emailAddress}
                  </p>
                </div>

                {/* Status Badges */}
                <div className="grid grid-cols-2 lg:grid-cols-1 gap-2 lg:gap-3 text-sm justify-self-center lg:justify-self-end">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="text-green-500" />
                    <span className={theme.colors.text.muted}>Verified</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link className="text-blue-500" />
                    <span className={theme.colors.text.muted}>
                      {user.externalAccounts.length} connected
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Card>

        {/* Error/Success Messages */}
        {(error || success) && (
          <Card className={`${theme.colors.background.card} ${theme.shadows.glass} border-0`}>
            <div className="p-4 lg:p-6">
              {error && (
                <Alert variant="destructive" className="animate-in slide-in-from-top-2 duration-300">
                  <AlertTriangle className="w-4 h-4" />
                  <AlertDescription>
                    {error}
                  </AlertDescription>
                </Alert>
              )}
              {success && (
                <Alert className="animate-in slide-in-from-top-2 duration-300 border-green-500/20 bg-green-500/10">
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <AlertDescription className="text-green-200">
                    {success}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </Card>
        )}

        {/* Profile Information */}
        <Card className={`${theme.colors.background.card} ${theme.shadows.glass} border-0`}>
          <div className="p-6 lg:p-8">
            <div className="grid gap-6">
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4 items-start">
                <div>
                  <h2 className={`text-xl lg:text-2xl font-semibold ${theme.colors.text.primary} ${typography.fontFamily.mono} tracking-wide mb-2`}>
                    Profile Information
                  </h2>
                  <p className={`text-sm ${theme.colors.text.helper}`}>
                    Update your personal details and account information
                  </p>
                </div>
                                 {!isEditingProfile && (
                   <Button
                     variant="secondary"
                     size="sm"
                     onClick={() => setIsEditingProfile(true)}
                     className="w-full lg:w-auto cursor-pointer flex items-center gap-2"
                   >
                                           <Edit className="w-3 h-3" />
                     <span>Edit Profile</span>
                   </Button>
                 )}
              </div>

              {isEditingProfile ? (
                <form onSubmit={handleProfileUpdate} className="grid gap-4 lg:gap-6">
                  <div className="grid gap-2">
                    <Label htmlFor="username" className="text-sm font-medium">Username</Label>
                    <Input
                      id="username"
                      value={profileForm.username}
                      onChange={(e) => setProfileForm(prev => ({ ...prev, username: e.target.value }))}
                      placeholder="Enter your username"
                      className="transition-all duration-200 focus:scale-[1.02]"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="email" className="text-sm font-medium">Email Address</Label>
                    <Input
                      id="email"
                      value={profileForm.email}
                      disabled
                      className={`${theme.colors.input.disabled} cursor-not-allowed`}
                    />
                    <p className={`text-xs ${theme.colors.text.helper} flex items-center gap-1`}>
                                             <Info className="w-3 h-3" />
                      Email changes require verification through account settings
                    </p>
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pt-4 border-t border-white/5">
                                                                 <Button
                         type="submit"
                         disabled={isLoading}
                         className="cursor-pointer flex items-center gap-2"
                       >
                         {isLoading ? (
                           <Loader2 className="w-3 h-3 animate-spin" />
                         ) : (
                           <Save className="w-3 h-3" />
                         )}
                         <span>{isLoading ? 'Saving...' : 'Save Changes'}</span>
                       </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setIsEditingProfile(false);
                        setProfileForm({
                          email: user.primaryEmailAddress?.emailAddress || '',
                          username: user.username || ''
                        });
                      }}
                      className="cursor-pointer"
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="grid gap-4 lg:gap-6">
                  <div className="grid gap-2">
                    <Label className={`${theme.colors.text.muted} text-xs uppercase tracking-wider font-medium`}>Username</Label>
                    <p className={`${theme.colors.text.primary} ${typography.fontFamily.mono} text-base lg:text-lg font-medium`}>
                      {profileForm.username || (
                        <span className={theme.colors.text.helper}>Not set</span>
                      )}
                    </p>
                  </div>
                  <div className="grid gap-2">
                    <Label className={`${theme.colors.text.muted} text-xs uppercase tracking-wider font-medium`}>Email Address</Label>
                    <p className={`${theme.colors.text.primary} ${typography.fontFamily.mono} text-base lg:text-lg font-medium flex items-center gap-2`}>
                      {profileForm.email}
                      <Badge variant="success" className="text-xs">Verified</Badge>
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>

        {/* Security Settings */}
        <Card className={`${theme.colors.background.card} ${theme.shadows.glass} border-0`}>
          <div className="p-6 lg:p-8">
            <div className="grid gap-6">
              <h2 className={`text-xl lg:text-2xl font-semibold ${theme.colors.text.primary} ${typography.fontFamily.mono} tracking-wide`}>
                Security
              </h2>

              <div className="grid gap-6">
                {/* Password Change */}
                <div className="grid gap-4">
                  <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4 items-center">
                    <div>
                      <h3 className={`font-medium ${theme.colors.text.primary} ${typography.fontFamily.mono} text-sm mb-1`}>
                        Password
                      </h3>
                      <p className={`text-xs ${theme.colors.text.helper}`}>
                        Last changed 30 days ago
                      </p>
                    </div>
                    {!isChangingPassword && (
                                           <Button
                       variant="secondary"
                       size="sm"
                       onClick={() => setIsChangingPassword(true)}
                       className="w-full lg:w-auto cursor-pointer flex items-center gap-2"
                     >
                       <Key className="w-3 h-3" />
                       <span>Change</span>
                     </Button>
                    )}
                  </div>

                  {isChangingPassword && (
                    <form onSubmit={handlePasswordChange} className="grid gap-4 pt-4 border-t border-white/5">
                      <div className="grid gap-2">
                        <Label htmlFor="currentPassword" className="text-sm font-medium">Current Password</Label>
                        <Input
                          id="currentPassword"
                          type="password"
                          value={passwordForm.currentPassword}
                          onChange={(e) => setPasswordForm(prev => ({ ...prev, currentPassword: e.target.value }))}
                          placeholder="Enter current password"
                          className="transition-all duration-200 focus:scale-[1.02]"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="newPassword" className="text-sm font-medium">New Password</Label>
                        <Input
                          id="newPassword"
                          type="password"
                          value={passwordForm.newPassword}
                          onChange={(e) => setPasswordForm(prev => ({ ...prev, newPassword: e.target.value }))}
                          placeholder="Enter new password"
                          className="transition-all duration-200 focus:scale-[1.02]"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="confirmPassword" className="text-sm font-medium">Confirm New Password</Label>
                        <Input
                          id="confirmPassword"
                          type="password"
                          value={passwordForm.confirmPassword}
                          onChange={(e) => setPasswordForm(prev => ({ ...prev, confirmPassword: e.target.value }))}
                          placeholder="Confirm new password"
                          className="transition-all duration-200 focus:scale-[1.02]"
                        />
                      </div>
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pt-2">
                                                 <Button
                           type="submit"
                           disabled={isLoading}
                           size="sm"
                           className="cursor-pointer flex items-center gap-2"
                         >
                           {isLoading ? (
                             <Loader2 className="w-3 h-3 animate-spin" />
                           ) : (
                             <Save className="w-3 h-3" />
                           )}
                           <span>Update</span>
                         </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setIsChangingPassword(false);
                            setPasswordForm({
                              currentPassword: '',
                              newPassword: '',
                              confirmPassword: ''
                            });
                          }}
                          className="cursor-pointer"
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  )}

                  <Separator />

                  {/* Two-Factor Authentication */}
                  <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4 items-center">
                    <div>
                      <h3 className={`font-medium ${theme.colors.text.primary} ${typography.fontFamily.mono} text-sm mb-1`}>
                        Two-Factor Authentication
                      </h3>
                      <p className={`text-xs ${theme.colors.text.helper}`}>
                        Add an extra layer of security
                      </p>
                    </div>
                    <Badge variant="warning" className="text-xs w-fit">Coming Soon</Badge>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Card>

        {/* Connected Accounts */}
        <Card className={`${theme.colors.background.card} ${theme.shadows.glass} border-0`}>
          <div className="p-6 lg:p-8">
            <div className="grid gap-6">
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4 items-start">
                <div>
                  <h2 className={`text-xl lg:text-2xl font-semibold ${theme.colors.text.primary} ${typography.fontFamily.mono} tracking-wide mb-2`}>
                    Connected Accounts
                  </h2>
                  <p className={`text-sm ${theme.colors.text.helper}`}>
                    Manage your social login connections and third-party integrations
                  </p>
                </div>
                                     <Button
                       variant="secondary"
                       onClick={() => openUserProfile()}
                       className="w-full lg:w-auto cursor-pointer flex items-center gap-2"
                     >
                       <Plus className="w-3 h-3" />
                       <span>Add Connection</span>
                     </Button>
              </div>

              {user.externalAccounts.length > 0 ? (
                <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
                  {user.externalAccounts.map((account) => (
                    <div
                      key={account.id}
                      className="group relative p-4 lg:p-6 rounded-xl border border-white/10 bg-black/20 backdrop-blur-xl transition-all duration-300 hover:border-white/20 hover:bg-black/30 hover:scale-105 cursor-pointer"
                    >
                      <div className="grid gap-4">
                        <div className="flex items-center gap-3 lg:gap-4">
                          <div className={`w-10 h-10 lg:w-12 lg:h-12 rounded-full bg-gradient-to-br from-white/20 to-white/5 grid place-items-center transition-all duration-300 group-hover:scale-110`}>
                            <div className="w-5 h-5 lg:w-6 lg:h-6 text-white flex items-center justify-center">
                              {getConnectionIcon(account.verification?.strategy || '') === 'google' && 'G'}
                              {getConnectionIcon(account.verification?.strategy || '') === 'github' && 'GH'}
                              {getConnectionIcon(account.verification?.strategy || '') === 'discord' && 'D'}
                              {getConnectionIcon(account.verification?.strategy || '') === 'link' && <Link className="w-4 h-4" />}
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className={`${theme.colors.text.primary} ${typography.fontFamily.mono} text-sm font-medium truncate`}>
                              {getConnectionName(account.verification?.strategy || '')}
                            </p>
                            <p className={`text-xs ${theme.colors.text.helper} truncate`}>
                              {account.emailAddress}
                            </p>
                          </div>
                        </div>
                        
                        <div className="flex items-center justify-between">
                          <Badge variant="success" className="text-xs">Connected</Badge>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConnectionToDisconnect(account.id);
                              setShowDisconnectModal(true);
                            }}
                            className="text-red-400 hover:text-red-300 p-2 transition-all duration-200 hover:scale-110 cursor-pointer"
                          >
                            <Unlink className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={Link}
                  title="No Connected Accounts"
                  description="Connect your favorite services to sign in faster and sync your data across platforms"
                  action={{
                    label: "Connect Your First Account",
                    onClick: () => openUserProfile(),
                    icon: Plus
                  }}
                />
              )}
            </div>
          </div>
        </Card>

        {/* Account Deletion */}
        <Card className={`${theme.colors.background.card} ${theme.shadows.glass} border-0 border-red-500/20`}>
          <div className="p-6 lg:p-8">
            <div className="grid gap-6">
              <div>
                <h2 className={`text-xl lg:text-2xl font-semibold ${theme.colors.text.primary} ${typography.fontFamily.mono} tracking-wide mb-2`}>
                  Danger Zone
                </h2>
                <p className={`text-sm ${theme.colors.text.helper}`}>
                  Irreversible and destructive actions
                </p>
              </div>

              <div className="grid gap-4">
                <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4 items-center p-4 lg:p-6 rounded-xl border border-red-500/20 bg-red-500/5 backdrop-blur-xl">
                  <div>
                    <h3 className={`font-medium ${theme.colors.text.primary} ${typography.fontFamily.mono} text-sm mb-1`}>
                      Delete Account
                    </h3>
                    <p className={`text-xs ${theme.colors.text.helper}`}>
                      Permanently delete your account and all associated data. This action cannot be undone.
                    </p>
                  </div>
                                       <Button
                       variant="destructive"
                       size="sm"
                       onClick={() => setShowDeleteAccountModal(true)}
                       className="w-full lg:w-auto cursor-pointer flex items-center gap-2"
                     >
                       <Trash2 className="w-3 h-3" />
                       <span>Delete Account</span>
                     </Button>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Disconnect Modal */}
      <Dialog open={showDisconnectModal} onOpenChange={(open) => {
        if (!open) {
          setShowDisconnectModal(false);
          setConnectionToDisconnect(null);
        }
      }}>
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
                <h3 className={`${theme.colors.text.primary} ${typography.fontFamily.mono} text-lg font-medium mb-1`}>
                  Disconnect Account?
                </h3>
                <p className={`text-sm ${theme.colors.text.helper}`}>
                  This action cannot be undone
                </p>
              </div>
            </div>
            
            <p className={`${theme.colors.text.secondary} ${typography.fontFamily.mono} text-sm`}>
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
                 className="cursor-pointer flex items-center gap-2"
               >
                 {isLoading ? (
                   <Loader2 className="w-3 h-3 animate-spin" />
                 ) : (
                   <Unlink className="w-3 h-3" />
                 )}
                 <span>{isLoading ? 'Disconnecting...' : 'Disconnect Account'}</span>
               </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Account Modal */}
      <Dialog open={showDeleteAccountModal} onOpenChange={(open) => {
        if (!open) {
          setShowDeleteAccountModal(false);
        }
      }}>
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
                <h3 className={`${theme.colors.text.primary} ${typography.fontFamily.mono} text-lg font-medium mb-1`}>
                  Delete Account?
                </h3>
                <p className={`text-sm ${theme.colors.text.helper}`}>
                  This action cannot be undone. All your data will be permanently deleted.
                </p>
              </div>
            </div>
            
            <p className={`${theme.colors.text.secondary} ${typography.fontFamily.mono} text-sm`}>
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
                 className="cursor-pointer flex items-center gap-2"
               >
                 {isLoading ? (
                   <Loader2 className="w-3 h-3 animate-spin" />
                 ) : (
                   <Trash2 className="w-3 h-3" />
                 )}
                 <span>{isLoading ? 'Deleting...' : 'Delete Account'}</span>
               </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default Profile; 