import { Link, useLocation } from 'react-router-dom';
import { useAuth, useClerk } from '@clerk/clerk-react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { createPortal } from 'react-dom';
import { theme, typography } from '../../config/theme';

const Header = () => {
  const { isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const location = useLocation();

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error('Error signing out:', error);
    }
  };

  const isActivePath = (path: string) => {
    return location.pathname === path;
  };

  return (
    <>
      {/* Desktop/Tablet Header */}
      <header className={`border-b ${theme.colors.border.primary} py-6 px-4 sm:px-6 relative lg:block hidden`}>
        <div className="container mx-auto max-w-6xl px-3 sm:px-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            {/* Left side - Logo and Brand */}
            <div className="flex flex-col sm:flex-row sm:items-center">
              <Link to="/" className={`text-3xl sm:text-4xl tracking-widest uppercase ${typography.fontFamily.display} ${theme.colors.text.primary} hover:${theme.colors.text.secondary} transition-colors duration-200`}>
                exit1.dev
              </Link>
              <div className={`mt-2 sm:mt-0 sm:ml-6 text-base sm:text-lg tracking-widest uppercase ${typography.fontFamily.display} ${theme.colors.text.primary} flex items-center gap-3`}>
                <span className="hidden sm:inline">→</span>
                <span>Website Monitor</span>
              </div>
            </div>

            {/* Desktop Navigation */}
            {isSignedIn && (
              <nav className="flex items-center gap-4">
                <Link
                  to="/websites"
                  className={`flex items-center gap-2 px-3 py-2 ${theme.colors.text.primary} hover:${theme.colors.text.secondary} transition-colors duration-200 ${typography.fontFamily.mono} text-sm tracking-wide`}
                >
                  <FontAwesomeIcon icon="globe" className="w-4 h-4" />
                  <span>Websites</span>
                </Link>
                <Link
                  to="/notifications"
                  className={`flex items-center gap-2 px-3 py-2 ${theme.colors.text.primary} hover:${theme.colors.text.secondary} transition-colors duration-200 ${typography.fontFamily.mono} text-sm tracking-wide`}
                >
                  <FontAwesomeIcon icon="bell" className="w-4 h-4" />
                  <span>Notifications</span>
                </Link>
                <Link
                  to="/profile"
                  className={`flex items-center gap-2 px-3 py-2 ${theme.colors.text.primary} hover:${theme.colors.text.secondary} transition-colors duration-200 ${typography.fontFamily.mono} text-sm tracking-wide`}
                >
                  <FontAwesomeIcon icon="user" className="w-4 h-4" />
                  <span>Profile</span>
                </Link>
                
                {/* Desktop Logout button */}
                <button
                  onClick={handleSignOut}
                  className={`flex items-center gap-2 px-4 py-2 ${theme.colors.text.primary} ${theme.colors.border.primary} rounded ${theme.colors.background.hover} transition-colors duration-200 ${typography.fontFamily.mono} text-sm tracking-wide cursor-pointer`}
                  title="Sign out"
                >
                  <FontAwesomeIcon icon="arrow-right-from-bracket" className="w-4 h-4" />
                  <span>Sign Out</span>
                </button>
              </nav>
            )}
          </div>
        </div>
      </header>

      {/* Mobile Header - Simplified */}
      <header className={`lg:hidden border-b ${theme.colors.border.primary} py-4 px-4`}>
        <div className="container mx-auto max-w-6xl px-3">
          <div className="flex items-center justify-center">
            <Link to="/" className={`text-2xl tracking-widest uppercase ${typography.fontFamily.display} ${theme.colors.text.primary}`}>
              exit1.dev
            </Link>
          </div>
        </div>
      </header>

      {/* Mobile Content Padding to Account for Bottom Navigation */}
      {isSignedIn && <div className="lg:hidden h-24"></div>}

      {/* Mobile Bottom Navigation - Rendered as Portal */}
      {isSignedIn && createPortal(
        <div className="lg:hidden fixed bottom-0 left-0 right-0 z-[100]">
          <nav className={`bg-black/30 backdrop-blur-2xl border-t ${theme.colors.border.primary} px-2 py-2 w-full ${theme.shadows.glass} before:absolute before:inset-0 before:bg-gradient-to-t before:from-black/20 before:to-transparent before:pointer-events-none relative`}>
            <div className="flex items-center justify-around max-w-lg mx-auto">
              
              {/* Websites Tab */}
              <Link
                to="/websites"
                className={`flex flex-col items-center justify-center px-3 py-2 min-w-0 flex-1 rounded-lg transition-colors duration-200 ${
                  isActivePath('/websites') 
                    ? `${theme.colors.background.hover} ${theme.colors.text.primary}` 
                    : `${theme.colors.text.secondary} hover:${theme.colors.text.primary} hover:${theme.colors.background.hover}`
                }`}
              >
                <div className="relative">
                  <FontAwesomeIcon 
                    icon="globe" 
                    className={`w-5 h-5 mb-1 ${isActivePath('/websites') ? 'opacity-100' : 'opacity-75'}`} 
                  />
                  {isActivePath('/websites') && (
                    <div className={`absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-1 h-1 ${theme.colors.text.primary} rounded-full`}></div>
                  )}
                </div>
                <span className={`text-xs ${typography.fontFamily.mono} tracking-wide ${isActivePath('/websites') ? 'font-medium' : 'font-normal'}`}>
                  Websites
                </span>
              </Link>

              {/* Notifications Tab */}
              <Link
                to="/notifications"
                className={`flex flex-col items-center justify-center px-3 py-2 min-w-0 flex-1 rounded-lg transition-colors duration-200 ${
                  isActivePath('/notifications') 
                    ? `${theme.colors.background.hover} ${theme.colors.text.primary}` 
                    : `${theme.colors.text.secondary} hover:${theme.colors.text.primary} hover:${theme.colors.background.hover}`
                }`}
              >
                <div className="relative">
                  <FontAwesomeIcon 
                    icon="bell" 
                    className={`w-5 h-5 mb-1 ${isActivePath('/notifications') ? 'opacity-100' : 'opacity-75'}`} 
                  />
                  {isActivePath('/notifications') && (
                    <div className={`absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-1 h-1 ${theme.colors.text.primary} rounded-full`}></div>
                  )}
                </div>
                <span className={`text-xs ${typography.fontFamily.mono} tracking-wide ${isActivePath('/notifications') ? 'font-medium' : 'font-normal'}`}>
                  Notifications
                </span>
              </Link>

              {/* Profile Tab */}
              <Link
                to="/profile"
                className={`flex flex-col items-center justify-center px-3 py-2 min-w-0 flex-1 rounded-lg transition-colors duration-200 ${
                  isActivePath('/profile') 
                    ? `${theme.colors.background.hover} ${theme.colors.text.primary}` 
                    : `${theme.colors.text.secondary} hover:${theme.colors.text.primary} hover:${theme.colors.background.hover}`
                }`}
              >
                <div className="relative">
                  <FontAwesomeIcon 
                    icon="user" 
                    className={`w-5 h-5 mb-1 ${isActivePath('/profile') ? 'opacity-100' : 'opacity-75'}`} 
                  />
                  {isActivePath('/profile') && (
                    <div className={`absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-1 h-1 ${theme.colors.text.primary} rounded-full`}></div>
                  )}
                </div>
                <span className={`text-xs ${typography.fontFamily.mono} tracking-wide ${isActivePath('/profile') ? 'font-medium' : 'font-normal'}`}>
                  Profile
                </span>
              </Link>

              {/* Sign Out Tab */}
              <button
                onClick={handleSignOut}
                className={`flex flex-col items-center justify-center px-3 py-2 min-w-0 flex-1 rounded-lg transition-colors duration-200 ${theme.colors.text.secondary} hover:${theme.colors.text.primary} hover:${theme.colors.background.hover} cursor-pointer`}
              >
                <div className="relative">
                  <FontAwesomeIcon 
                    icon="arrow-right-from-bracket" 
                    className="w-5 h-5 mb-1 opacity-75" 
                  />
                </div>
                <span className={`text-xs ${typography.fontFamily.mono} tracking-wide font-normal`}>
                  Sign Out
                </span>
              </button>

            </div>
          </nav>
        </div>,
        document.body
      )}
    </>
  );
};

export default Header; 