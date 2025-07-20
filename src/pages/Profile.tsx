import React, { useState, useEffect } from 'react';
import { useUser, useClerk } from '@clerk/clerk-react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Card, Button, Input, Label, Badge, Divider, Modal } from '../components/ui';
import { theme, typography } from '../config/theme';

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
      // Find the external account and disconnect it
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

  const getConnectionIconPrefix = (strategy: string) => {
    switch (strategy) {
      case 'oauth_google':
      case 'oauth_github':
      case 'oauth_discord':
        return 'fab';
      default:
        return 'fas';
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
      <div className="flex items-center justify-center min-h-[600px]">
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
    <div className="min-h-screen bg-gradient-to-br from-black via-neutral-900/20 to-black">
      <div className="container mx-auto max-w-6xl px-4 py-8">
        {/* Header with Profile Avatar */}
        <div className="mb-12">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6 mb-8">
            {/* Profile Avatar */}
            <div className="relative group">
              <div className="w-24 h-24 sm:w-32 sm:h-32 rounded-full bg-gradient-to-br from-white/20 to-white/5 backdrop-blur-xl border border-white/10 flex items-center justify-center text-2xl sm:text-3xl font-bold text-white shadow-2xl transition-all duration-300 group-hover:shadow-[0_0_40px_rgba(255,255,255,0.15)] group-hover:scale-105">
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
                className="absolute -bottom-2 -right-2 w-8 h-8 bg-white/90 hover:bg-white rounded-full flex items-center justify-center transition-all duration-200 hover:scale-110 shadow-lg"
              >
                <FontAwesomeIcon icon={['fas', 'camera']} className="w-3 h-3 text-black" />
              </button>
            </div>
            
            {/* User Info */}
            <div className="flex-1">
              <h1 className={`text-3xl sm:text-4xl font-bold tracking-tight ${theme.colors.text.primary} ${typography.fontFamily.display} mb-2`}>
                {user.username || user.primaryEmailAddress?.emailAddress?.split('@')[0] || 'Welcome'}
              </h1>
              <p className={`${theme.colors.text.secondary} ${typography.fontFamily.mono} text-lg mb-4`}>
                {user.primaryEmailAddress?.emailAddress}
              </p>
              <div className="flex flex-wrap gap-2">
                <Badge variant="success" className="flex items-center gap-1">
                  <FontAwesomeIcon icon={['fas', 'check-circle']} className="w-3 h-3" />
                  Verified
                </Badge>
                {user.externalAccounts.length > 0 && (
                  <Badge variant="success" className="flex items-center gap-1">
                    <FontAwesomeIcon icon={['fas', 'link']} className="w-3 h-3" />
                    {user.externalAccounts.length} Connected
                  </Badge>
                )}
              </div>
            </div>
          </div>

          {/* Page Description */}
          <p className={`${theme.colors.text.secondary} ${typography.fontFamily.mono} text-sm tracking-wide max-w-2xl`}>
            Manage your account settings, security preferences, and connected services all in one place.
          </p>
        </div>

        {/* Error/Success Messages */}
        {error && (
          <div className={`mb-8 p-4 ${theme.colors.badge.error} rounded-xl ${typography.fontFamily.mono} text-sm backdrop-blur-xl border border-red-500/20 animate-in slide-in-from-top-2 duration-300`}>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={['fas', 'exclamation-triangle']} className="w-4 h-4" />
              {error}
            </div>
          </div>
        )}
        {success && (
          <div className={`mb-8 p-4 ${theme.colors.badge.success} rounded-xl ${typography.fontFamily.mono} text-sm backdrop-blur-xl border border-green-500/20 animate-in slide-in-from-top-2 duration-300`}>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={['fas', 'check-circle']} className="w-4 h-4" />
              {success}
            </div>
          </div>
        )}

        <div className="grid gap-8 lg:grid-cols-3">
          {/* Profile Information */}
          <div className="lg:col-span-2">
            <Card className={`${theme.colors.background.card} ${theme.shadows.glass} transition-all duration-300 hover:shadow-[0_8px_40px_0_rgba(0,0,0,0.4)]`}>
              <div className="p-8">
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h2 className={`text-2xl font-semibold ${theme.colors.text.primary} ${typography.fontFamily.mono} tracking-wide mb-2`}>
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
                      className="flex items-center gap-2 transition-all duration-200 hover:scale-105"
                    >
                      <FontAwesomeIcon icon={['fas', 'edit']} className="w-3 h-3" />
                      Edit Profile
                    </Button>
                  )}
                </div>

                {isEditingProfile ? (
                  <form onSubmit={handleProfileUpdate} className="space-y-6">
                    <div className="space-y-2">
                      <Label htmlFor="username" className="text-sm font-medium">Username</Label>
                      <Input
                        id="username"
                        value={profileForm.username}
                        onChange={(e) => setProfileForm(prev => ({ ...prev, username: e.target.value }))}
                        placeholder="Enter your username"
                        className="transition-all duration-200 focus:scale-[1.02]"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="email" className="text-sm font-medium">Email Address</Label>
                      <Input
                        id="email"
                        value={profileForm.email}
                        disabled
                        className={`${theme.colors.input.disabled} cursor-not-allowed`}
                      />
                      <p className={`text-xs ${theme.colors.text.helper} flex items-center gap-1`}>
                        <FontAwesomeIcon icon={['fas', 'info-circle']} className="w-3 h-3" />
                        Email changes require verification through account settings
                      </p>
                    </div>
                    <div className="flex gap-3 pt-6 border-t border-white/5">
                      <Button
                        type="submit"
                        disabled={isLoading}
                        className="flex items-center gap-2 transition-all duration-200 hover:scale-105"
                      >
                        {isLoading ? (
                          <FontAwesomeIcon icon={['fas', 'spinner']} className="w-3 h-3 animate-spin" />
                        ) : (
                          <FontAwesomeIcon icon={['fas', 'save']} className="w-3 h-3" />
                        )}
                        {isLoading ? 'Saving...' : 'Save Changes'}
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
                        className="transition-all duration-200 hover:scale-105"
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <Label className={`${theme.colors.text.muted} text-xs uppercase tracking-wider font-medium`}>Username</Label>
                      <p className={`${theme.colors.text.primary} ${typography.fontFamily.mono} text-lg font-medium`}>
                        {profileForm.username || (
                          <span className={theme.colors.text.helper}>Not set</span>
                        )}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label className={`${theme.colors.text.muted} text-xs uppercase tracking-wider font-medium`}>Email Address</Label>
                      <p className={`${theme.colors.text.primary} ${typography.fontFamily.mono} text-lg font-medium flex items-center gap-2`}>
                        {profileForm.email}
                        <Badge variant="success" className="text-xs">Verified</Badge>
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </div>

          {/* Security Settings */}
          <div className="space-y-8">
            <Card className={`${theme.colors.background.card} ${theme.shadows.glass} transition-all duration-300 hover:shadow-[0_8px_40px_0_rgba(0,0,0,0.4)]`}>
              <div className="p-6">
                <h2 className={`text-xl font-semibold ${theme.colors.text.primary} ${typography.fontFamily.mono} tracking-wide mb-6`}>
                  Security
                </h2>

                {/* Password Change */}
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
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
                        className="flex items-center gap-2 transition-all duration-200 hover:scale-105"
                      >
                        <FontAwesomeIcon icon={['fas', 'key']} className="w-3 h-3" />
                        Change
                      </Button>
                    )}
                  </div>

                  {isChangingPassword && (
                    <form onSubmit={handlePasswordChange} className="space-y-4 pt-4 border-t border-white/5">
                      <div>
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
                      <div>
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
                      <div>
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
                      <div className="flex gap-3 pt-2">
                        <Button
                          type="submit"
                          disabled={isLoading}
                          size="sm"
                          className="flex items-center gap-2 transition-all duration-200 hover:scale-105"
                        >
                          {isLoading ? (
                            <FontAwesomeIcon icon={['fas', 'spinner']} className="w-3 h-3 animate-spin" />
                          ) : (
                            <FontAwesomeIcon icon={['fas', 'save']} className="w-3 h-3" />
                          )}
                          Update
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
                          className="transition-all duration-200 hover:scale-105"
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  )}

                  <Divider />

                  {/* Two-Factor Authentication */}
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className={`font-medium ${theme.colors.text.primary} ${typography.fontFamily.mono} text-sm mb-1`}>
                        Two-Factor Authentication
                      </h3>
                      <p className={`text-xs ${theme.colors.text.helper}`}>
                        Add an extra layer of security
                      </p>
                    </div>
                    <Badge variant="warning" className="text-xs">Coming Soon</Badge>
                  </div>
                </div>
              </div>
            </Card>

            {/* Quick Stats */}
            <Card className={`${theme.colors.background.card} ${theme.shadows.glass} transition-all duration-300 hover:shadow-[0_8px_40px_0_rgba(0,0,0,0.4)]`}>
              <div className="p-6">
                <h3 className={`text-lg font-semibold ${theme.colors.text.primary} ${typography.fontFamily.mono} tracking-wide mb-4`}>
                  Account Activity
                </h3>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className={`text-sm ${theme.colors.text.secondary}`}>Last Login</span>
                    <span className={`text-sm ${theme.colors.text.primary} ${typography.fontFamily.mono}`}>
                      {new Date().toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className={`text-sm ${theme.colors.text.secondary}`}>Account Created</span>
                    <span className={`text-sm ${theme.colors.text.primary} ${typography.fontFamily.mono}`}>
                      {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className={`text-sm ${theme.colors.text.secondary}`}>Connected Services</span>
                    <span className={`text-sm ${theme.colors.text.primary} ${typography.fontFamily.mono}`}>
                      {user.externalAccounts.length}
                    </span>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </div>

        {/* Connected Accounts */}
        <Card className={`${theme.colors.background.card} ${theme.shadows.glass} mt-8 transition-all duration-300 hover:shadow-[0_8px_40px_0_rgba(0,0,0,0.4)]`}>
          <div className="p-8">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className={`text-2xl font-semibold ${theme.colors.text.primary} ${typography.fontFamily.mono} tracking-wide mb-2`}>
                  Connected Accounts
                </h2>
                <p className={`text-sm ${theme.colors.text.helper}`}>
                  Manage your social login connections and third-party integrations
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={() => openUserProfile()}
                className="flex items-center gap-2 transition-all duration-200 hover:scale-105"
              >
                <FontAwesomeIcon icon={['fas', 'plus']} className="w-3 h-3" />
                Add Connection
              </Button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {user.externalAccounts.map((account) => (
                <div
                  key={account.id}
                  className="group relative p-6 rounded-xl border border-white/10 bg-black/20 backdrop-blur-xl transition-all duration-300 hover:border-white/20 hover:bg-black/30 hover:scale-105"
                >
                  <div className="flex items-center gap-4 mb-4">
                    <div className={`w-12 h-12 rounded-full bg-gradient-to-br from-white/20 to-white/5 flex items-center justify-center transition-all duration-300 group-hover:scale-110`}>
                      <FontAwesomeIcon 
                        icon={[getConnectionIconPrefix(account.verification?.strategy || ''), getConnectionIcon(account.verification?.strategy || '')]} 
                        className="w-6 h-6 text-white" 
                      />
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
                      onClick={() => {
                        setConnectionToDisconnect(account.id);
                        setShowDisconnectModal(true);
                      }}
                      className="text-red-400 hover:text-red-300 p-2 transition-all duration-200 hover:scale-110"
                    >
                      <FontAwesomeIcon icon={['fas', 'unlink']} className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}

              {user.externalAccounts.length === 0 && (
                <div className="col-span-full text-center py-12">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-white/5 flex items-center justify-center">
                    <FontAwesomeIcon icon={['fas', 'link']} className="w-8 h-8 text-neutral-500" />
                  </div>
                  <h3 className={`${theme.colors.text.primary} ${typography.fontFamily.mono} text-lg font-medium mb-2`}>
                    No Connected Accounts
                  </h3>
                  <p className={`text-sm ${theme.colors.text.helper} mb-6 max-w-md mx-auto`}>
                    Connect your favorite services to sign in faster and sync your data across platforms
                  </p>
                  <Button
                    variant="primary"
                    onClick={() => openUserProfile()}
                    className="flex items-center gap-2 mx-auto transition-all duration-200 hover:scale-105"
                  >
                    <FontAwesomeIcon icon={['fas', 'plus']} className="w-3 h-3" />
                    Connect Your First Account
                  </Button>
                </div>
              )}
            </div>
          </div>
        </Card>

        {/* Disconnect Modal */}
        <Modal
          isOpen={showDisconnectModal}
          onClose={() => {
            setShowDisconnectModal(false);
            setConnectionToDisconnect(null);
          }}
          title="Disconnect Account"
        >
          <div className="p-6">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
                <FontAwesomeIcon icon={['fas', 'exclamation-triangle']} className="w-6 h-6 text-red-400" />
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
            
            <p className={`${theme.colors.text.secondary} ${typography.fontFamily.mono} text-sm mb-8`}>
              Are you sure you want to disconnect this account? You won't be able to sign in with it anymore, 
              and you'll need to reconnect it if you want to use it again.
            </p>
            
            <div className="flex gap-3 justify-end">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowDisconnectModal(false);
                  setConnectionToDisconnect(null);
                }}
                className="transition-all duration-200 hover:scale-105"
              >
                Keep Connected
              </Button>
              <Button
                variant="danger"
                onClick={handleDisconnectConnection}
                disabled={isLoading}
                className="flex items-center gap-2 transition-all duration-200 hover:scale-105"
              >
                {isLoading ? (
                  <FontAwesomeIcon icon={['fas', 'spinner']} className="w-3 h-3 animate-spin" />
                ) : (
                  <FontAwesomeIcon icon={['fas', 'unlink']} className="w-3 h-3" />
                )}
                {isLoading ? 'Disconnecting...' : 'Disconnect Account'}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  );
};

export default Profile; 