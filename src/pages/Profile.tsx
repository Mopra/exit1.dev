import React, { useState, useEffect } from 'react';
import { useUser, useClerk } from '@clerk/clerk-react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Card, Button, Input, Label, Badge, Divider, Modal } from '../components/ui';
import { theme, typography } from '../config/theme';
import { faUser, faKey, faLink, faCheckCircle, faExclamationTriangle, faCamera, faEdit, faSave, faSpinner, faPlus, faUnlink, faTrash } from '@fortawesome/pro-regular-svg-icons';
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

  const handleDeleteAccount = async () => {
    if (!user) return;

    setIsLoading(true);
    setError(null);
    setSuccess(null);

    try {
      // First delete all user data from Firestore
      const result = await apiClient.deleteUserAccount();
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete user data');
      }

      // Then delete the user from Clerk
      await user.delete();
      
      setSuccess('Account deleted successfully!');
      setShowDeleteAccountModal(false);
      // Clerk will handle redirecting to the sign-in page
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
    <>
      {/* Profile Section */}
      <Card className="py-4 sm:py-6 mb-8 sm:mb-12 border-0">
        {/* Main Header */}
        <div className="px-3 sm:px-4 lg:px-6 mb-4 sm:mb-6">
          <div className="flex flex-col gap-3 sm:gap-4">
            {/* Title and Primary Actions */}
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 sm:gap-4">
              <h1 className={`text-xl sm:text-2xl uppercase tracking-widest ${typography.fontFamily.display} ${theme.colors.text.primary}`}>
                Account Profile
              </h1>
              <div className="flex gap-2">
                <Button
                  onClick={() => openUserProfile()}
                  variant="primary"
                  size="sm"
                  className="flex items-center gap-2 w-full sm:w-auto justify-center"
                >
                  <FontAwesomeIcon icon={faUser} className="w-3 h-3" />
                  Account Settings
                </Button>
              </div>
            </div>

            {/* User Info and Stats */}
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 sm:gap-4">
              {/* User Info Display */}
              <div className="flex items-center gap-3 sm:gap-4">
                <div className="relative group">
                  <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-gradient-to-br from-white/20 to-white/5 backdrop-blur-xl border border-white/10 flex items-center justify-center text-lg sm:text-xl font-bold text-white shadow-2xl transition-all duration-300 group-hover:shadow-[0_0_40px_rgba(255,255,255,0.15)] group-hover:scale-105">
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
                    className="absolute -bottom-1 -right-1 w-6 h-6 sm:w-8 sm:h-8 bg-white/90 hover:bg-white rounded-full flex items-center justify-center transition-all duration-200 hover:scale-110 shadow-lg cursor-pointer"
                  >
                    <FontAwesomeIcon icon={faCamera} className="w-2 h-2 sm:w-3 sm:h-3 text-black" />
                  </button>
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className={`text-lg sm:text-xl font-bold tracking-tight ${theme.colors.text.primary} ${typography.fontFamily.display} mb-1`}>
                    {user.username || user.primaryEmailAddress?.emailAddress?.split('@')[0] || 'Welcome'}
                  </h2>
                  <p className={`${theme.colors.text.secondary} ${typography.fontFamily.mono} text-sm sm:text-base truncate`}>
                    {user.primaryEmailAddress?.emailAddress}
                  </p>
                </div>
              </div>

              {/* Quick Stats */}
              <div className="flex items-center gap-3 sm:gap-4 text-sm">
                <div className="flex items-center gap-2 sm:gap-3">
                  <span className="flex items-center gap-1">
                    <FontAwesomeIcon icon={faCheckCircle} className="text-green-500" />
                    <span className={theme.colors.text.muted}>
                      Verified
                    </span>
                  </span>
                  <span className="flex items-center gap-1">
                    <FontAwesomeIcon icon={faLink} className="text-blue-500" />
                    <span className={theme.colors.text.muted}>
                      {user.externalAccounts.length} connected
                    </span>
                  </span>
                  <span className={`${typography.fontFamily.mono} ${theme.colors.text.muted} hidden sm:inline`}>
                    {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Error/Success Messages */}
        {(error || success) && (
          <div className="px-3 sm:px-4 lg:px-6 mb-4 sm:mb-6">
            {error && (
              <div className={`p-3 sm:p-4 ${theme.colors.badge.error} rounded-xl ${typography.fontFamily.mono} text-sm backdrop-blur-xl border border-red-500/20 animate-in slide-in-from-top-2 duration-300`}>
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faExclamationTriangle} className="w-4 h-4" />
                  {error}
                </div>
              </div>
            )}
            {success && (
              <div className={`p-3 sm:p-4 ${theme.colors.badge.success} rounded-xl ${typography.fontFamily.mono} text-sm backdrop-blur-xl border border-green-500/20 animate-in slide-in-from-top-2 duration-300`}>
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faCheckCircle} className="w-4 h-4" />
                  {success}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Profile Information */}
        <div className="px-3 sm:px-4 lg:px-6 mb-6">
          <Card className={`${theme.colors.background.card} ${theme.shadows.glass} transition-all duration-300 hover:shadow-[0_8px_40px_0_rgba(0,0,0,0.4)]`}>
            <div className="p-4 sm:p-6 lg:p-8">
              <div className="flex items-center justify-between mb-4 sm:mb-6">
                <div>
                  <h2 className={`text-lg sm:text-xl lg:text-2xl font-semibold ${theme.colors.text.primary} ${typography.fontFamily.mono} tracking-wide mb-1 sm:mb-2`}>
                    Profile Information
                  </h2>
                  <p className={`text-xs sm:text-sm ${theme.colors.text.helper}`}>
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
                    <FontAwesomeIcon icon={faEdit} className="w-3 h-3" />
                    Edit Profile
                  </Button>
                )}
              </div>

              {isEditingProfile ? (
                <form onSubmit={handleProfileUpdate} className="space-y-4 sm:space-y-6">
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
                      <FontAwesomeIcon icon="info-circle" className="w-3 h-3" />
                      Email changes require verification through account settings
                    </p>
                  </div>
                  <div className="flex gap-3 pt-4 sm:pt-6 border-t border-white/5">
                    <Button
                      type="submit"
                      disabled={isLoading}
                      className="flex items-center gap-2 transition-all duration-200 hover:scale-105"
                    >
                      {isLoading ? (
                        <FontAwesomeIcon icon={faSpinner} className="w-3 h-3 animate-spin" />
                      ) : (
                        <FontAwesomeIcon icon={faSave} className="w-3 h-3" />
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
                <div className="space-y-4 sm:space-y-6">
                  <div className="space-y-2">
                    <Label className={`${theme.colors.text.muted} text-xs uppercase tracking-wider font-medium`}>Username</Label>
                    <p className={`${theme.colors.text.primary} ${typography.fontFamily.mono} text-base sm:text-lg font-medium`}>
                      {profileForm.username || (
                        <span className={theme.colors.text.helper}>Not set</span>
                      )}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label className={`${theme.colors.text.muted} text-xs uppercase tracking-wider font-medium`}>Email Address</Label>
                    <p className={`${theme.colors.text.primary} ${typography.fontFamily.mono} text-base sm:text-lg font-medium flex items-center gap-2`}>
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
        <div className="px-3 sm:px-4 lg:px-6 mb-6">
          <Card className={`${theme.colors.background.card} ${theme.shadows.glass} transition-all duration-300 hover:shadow-[0_8px_40px_0_rgba(0,0,0,0.4)]`}>
            <div className="p-4 sm:p-6">
              <h2 className={`text-lg sm:text-xl font-semibold ${theme.colors.text.primary} ${typography.fontFamily.mono} tracking-wide mb-4 sm:mb-6`}>
                Security
              </h2>

              {/* Password Change */}
              <div className="space-y-4 sm:space-y-6">
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
                      <FontAwesomeIcon icon={faKey} className="w-3 h-3" />
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
                          <FontAwesomeIcon icon={faSpinner} className="w-3 h-3 animate-spin" />
                        ) : (
                          <FontAwesomeIcon icon={faSave} className="w-3 h-3" />
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
        </div>

        {/* Connected Accounts */}
        <div className="px-3 sm:px-4 lg:px-6 mb-6">
          <Card className={`${theme.colors.background.card} ${theme.shadows.glass} transition-all duration-300 hover:shadow-[0_8px_40px_0_rgba(0,0,0,0.4)]`}>
            <div className="p-4 sm:p-6 lg:p-8">
              <div className="flex items-center justify-between mb-4 sm:mb-6 lg:mb-8">
                <div>
                  <h2 className={`text-lg sm:text-xl lg:text-2xl font-semibold ${theme.colors.text.primary} ${typography.fontFamily.mono} tracking-wide mb-1 sm:mb-2`}>
                    Connected Accounts
                  </h2>
                  <p className={`text-xs sm:text-sm ${theme.colors.text.helper}`}>
                    Manage your social login connections and third-party integrations
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => openUserProfile()}
                  className="flex items-center gap-2 transition-all duration-200 hover:scale-105"
                >
                  <FontAwesomeIcon icon={faPlus} className="w-3 h-3" />
                  Add Connection
                </Button>
              </div>

              <div className="grid gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {user.externalAccounts.map((account) => (
                  <div
                    key={account.id}
                    className="group relative p-4 sm:p-6 rounded-xl border border-white/10 bg-black/20 backdrop-blur-xl transition-all duration-300 hover:border-white/20 hover:bg-black/30 hover:scale-105"
                  >
                    <div className="flex items-center gap-3 sm:gap-4 mb-3 sm:mb-4">
                      <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-gradient-to-br from-white/20 to-white/5 flex items-center justify-center transition-all duration-300 group-hover:scale-110`}>
                        <FontAwesomeIcon 
                          icon={[getConnectionIconPrefix(account.verification?.strategy || ''), getConnectionIcon(account.verification?.strategy || '')]} 
                          className="w-5 h-5 sm:w-6 sm:h-6 text-white" 
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
                        <FontAwesomeIcon icon={faUnlink} className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))}

                {user.externalAccounts.length === 0 && (
                  <div className="col-span-full text-center py-8 sm:py-12">
                    <div className="w-12 h-12 sm:w-16 sm:h-16 mx-auto mb-3 sm:mb-4 rounded-full bg-white/5 flex items-center justify-center">
                      <FontAwesomeIcon icon={faLink} className="w-6 h-6 sm:w-8 sm:h-8 text-neutral-500" />
                    </div>
                    <h3 className={`${theme.colors.text.primary} ${typography.fontFamily.mono} text-base sm:text-lg font-medium mb-2`}>
                      No Connected Accounts
                    </h3>
                    <p className={`text-xs sm:text-sm ${theme.colors.text.helper} mb-4 sm:mb-6 max-w-md mx-auto`}>
                      Connect your favorite services to sign in faster and sync your data across platforms
                    </p>
                    <Button
                      variant="primary"
                      onClick={() => openUserProfile()}
                      className="flex items-center gap-2 mx-auto transition-all duration-200 hover:scale-105"
                    >
                      <FontAwesomeIcon icon={faPlus} className="w-3 h-3" />
                      Connect Your First Account
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </Card>
        </div>

        {/* Account Deletion */}
        <div className="px-3 sm:px-4 lg:px-6">
          <Card className={`${theme.colors.background.card} ${theme.shadows.glass} transition-all duration-300 hover:shadow-[0_8px_40px_0_rgba(0,0,0,0.4)] border-red-500/20`}>
            <div className="p-4 sm:p-6 lg:p-8">
              <div className="flex items-center justify-between mb-4 sm:mb-6">
                <div>
                  <h2 className={`text-lg sm:text-xl lg:text-2xl font-semibold ${theme.colors.text.primary} ${typography.fontFamily.mono} tracking-wide mb-1 sm:mb-2`}>
                    Danger Zone
                  </h2>
                  <p className={`text-xs sm:text-sm ${theme.colors.text.helper}`}>
                    Irreversible and destructive actions
                  </p>
                </div>
              </div>

              <div className="space-y-4 sm:space-y-6">
                <div className="flex items-center justify-between p-4 sm:p-6 rounded-xl border border-red-500/20 bg-red-500/5 backdrop-blur-xl">
                  <div className="flex-1">
                    <h3 className={`font-medium ${theme.colors.text.primary} ${typography.fontFamily.mono} text-sm mb-1`}>
                      Delete Account
                    </h3>
                    <p className={`text-xs ${theme.colors.text.helper}`}>
                      Permanently delete your account and all associated data. This action cannot be undone.
                    </p>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setShowDeleteAccountModal(true)}
                    className="flex items-center gap-2 transition-all duration-200 hover:scale-105"
                  >
                    <FontAwesomeIcon icon={faTrash} className="w-3 h-3" />
                    Delete Account
                  </Button>
                </div>
              </div>
            </div>
          </Card>
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
        <div className="p-4 sm:p-6">
          <div className="flex items-center gap-3 sm:gap-4 mb-4 sm:mb-6">
            <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-red-500/20 flex items-center justify-center">
              <FontAwesomeIcon icon={faExclamationTriangle} className="w-5 h-5 sm:w-6 sm:h-6 text-red-400" />
            </div>
            <div>
              <h3 className={`${theme.colors.text.primary} ${typography.fontFamily.mono} text-base sm:text-lg font-medium mb-1`}>
                Disconnect Account?
              </h3>
              <p className={`text-xs sm:text-sm ${theme.colors.text.helper}`}>
                This action cannot be undone
              </p>
            </div>
          </div>
          
          <p className={`${theme.colors.text.secondary} ${typography.fontFamily.mono} text-xs sm:text-sm mb-6 sm:mb-8`}>
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
                <FontAwesomeIcon icon={faSpinner} className="w-3 h-3 animate-spin" />
              ) : (
                <FontAwesomeIcon icon={faUnlink} className="w-3 h-3" />
              )}
              {isLoading ? 'Disconnecting...' : 'Disconnect Account'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete Account Modal */}
      <Modal
        isOpen={showDeleteAccountModal}
        onClose={() => setShowDeleteAccountModal(false)}
        title="Delete Account"
      >
        <div className="p-4 sm:p-6">
          <div className="flex items-center gap-3 sm:gap-4 mb-4 sm:mb-6">
            <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-red-500/20 flex items-center justify-center">
              <FontAwesomeIcon icon={faTrash} className="w-5 h-5 sm:w-6 sm:h-6 text-red-400" />
            </div>
            <div>
              <h3 className={`${theme.colors.text.primary} ${typography.fontFamily.mono} text-base sm:text-lg font-medium mb-1`}>
                Delete Account?
              </h3>
              <p className={`text-xs sm:text-sm ${theme.colors.text.helper}`}>
                This action cannot be undone. All your data will be permanently deleted.
              </p>
            </div>
          </div>
          
          <p className={`${theme.colors.text.secondary} ${typography.fontFamily.mono} text-xs sm:text-sm mb-6 sm:mb-8`}>
            Are you absolutely sure you want to delete your account? This will permanently delete your account and all associated data.
          </p>
          
          <div className="flex gap-3 justify-end">
            <Button
              variant="ghost"
              onClick={() => setShowDeleteAccountModal(false)}
              className="transition-all duration-200 hover:scale-105"
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDeleteAccount}
              disabled={isLoading}
              className="flex items-center gap-2 transition-all duration-200 hover:scale-105"
            >
              {isLoading ? (
                <FontAwesomeIcon icon={faSpinner} className="w-3 h-3 animate-spin" />
              ) : (
                <FontAwesomeIcon icon={faTrash} className="w-3 h-3" />
              )}
              {isLoading ? 'Deleting...' : 'Delete Account'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
};

export default Profile; 