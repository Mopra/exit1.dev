import { Link, useLocation } from 'react-router-dom';
import { useAuth, useClerk } from '@clerk/clerk-react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { createPortal } from 'react-dom';
import { theme } from '../../config/theme';

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
      {/* Desktop/Tablet Floating Header */}
      <header className={`sticky top-4 z-[40] lg:block hidden`}>
        <div className={`${theme.colors.background.card} py-4 px-6 ${theme.spacing.container} mx-auto mx-4 ${theme.borderRadius.xl} ${theme.shadows.lg}`}>
          <div className="flex items-center justify-between gap-8">
            {/* Left side - Logo and Brand */}
            <div className="flex items-center">
              <Link to="/" className={`text-2xl font-bold ${theme.colors.text.primary} hover:${theme.colors.text.secondary} ${theme.animation.transition.colors} ${theme.animation.duration[200]}`}>
                exit1.dev
              </Link>
            </div>

            {/* Desktop Navigation */}
            {isSignedIn && (
              <nav className="flex items-center gap-6">
                <Link
                  to="/checks"
                  className={`flex items-center gap-2 px-3 py-2 ${theme.colors.text.secondary} hover:${theme.colors.text.primary} ${theme.colors.background.hover} ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${theme.typography.fontWeight.medium} rounded-lg`}
                >
                  <FontAwesomeIcon icon="globe" className="w-4 h-4" />
                  <span>Checks</span>
                </Link>
                <Link
                  to="/webhooks"
                  className={`flex items-center gap-2 px-3 py-2 ${theme.colors.text.secondary} hover:${theme.colors.text.primary} ${theme.colors.background.hover} ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${theme.typography.fontWeight.medium} rounded-lg`}
                >
                  <FontAwesomeIcon icon="bell" className="w-4 h-4" />
                  <span>Webhooks</span>
                </Link>
                <Link
                  to="/logs"
                  className={`flex items-center gap-2 px-3 py-2 ${theme.colors.text.secondary} hover:${theme.colors.text.primary} ${theme.colors.background.hover} ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${theme.typography.fontWeight.medium} rounded-lg`}
                >
                  <FontAwesomeIcon icon="database" className="w-4 h-4" />
                  <span>Logs</span>
                </Link>
                <Link
                  to="/profile"
                  className={`flex items-center gap-2 px-3 py-2 ${theme.colors.text.secondary} hover:${theme.colors.text.primary} ${theme.colors.background.hover} ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${theme.typography.fontWeight.medium} rounded-lg`}
                >
                  <FontAwesomeIcon icon="user" className="w-4 h-4" />
                  <span>Profile</span>
                </Link>
                
                {/* Desktop Logout button */}
                <button
                  onClick={handleSignOut}
                  className={`flex items-center gap-2 px-4 py-2 ${theme.colors.text.secondary} hover:${theme.colors.text.primary} ${theme.colors.background.hover} ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${theme.typography.fontWeight.medium} cursor-pointer rounded-lg`}
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

      {/* Mobile Floating Header */}
      <header className={`lg:hidden sticky top-4 z-[40]`}>
        <div className={`${theme.colors.background.card} py-4 px-6 mx-4 ${theme.borderRadius.xl} ${theme.shadows.lg}`}>
          <div className="flex items-center justify-center">
            <Link to="/" className={`text-xl font-bold ${theme.colors.text.primary}`}>
              exit1.dev
            </Link>
          </div>
        </div>
      </header>

      {/* Content Padding to Account for Floating Headers */}
      <div className="lg:block hidden h-28"></div>
      {isSignedIn && <div className="lg:hidden h-24"></div>}

      {/* Mobile Bottom Navigation - Rendered as Portal */}
      {isSignedIn && createPortal(
        <div className="lg:hidden fixed bottom-4 left-4 right-4 z-[30]">
          <nav className={`${theme.colors.background.card} px-2 py-2 w-full ${theme.borderRadius.xl} ${theme.shadows.lg}`}>
            <div className="flex items-center justify-around max-w-lg mx-auto">
              
              {/* Checks Tab */}
              <Link
                to="/checks"
                className={`flex flex-col items-center justify-center px-3 py-2 min-w-0 flex-1 ${theme.borderRadius.lg} ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${
                  isActivePath('/checks') 
                    ? `${theme.colors.background.hover} ${theme.colors.text.primary}` 
                    : `${theme.colors.text.secondary} hover:${theme.colors.text.primary} hover:${theme.colors.background.hover}`
                }`}
              >
                <div className="relative">
                  <FontAwesomeIcon 
                    icon="globe" 
                    className={`w-5 h-5 mb-1 ${isActivePath('/checks') ? 'opacity-100' : 'opacity-75'}`} 
                  />
                  {isActivePath('/checks') && (
                    <div className={`absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-1 h-1 ${theme.colors.text.primary} rounded-full`}></div>
                  )}
                </div>
                <span className={`text-xs ${theme.typography.fontWeight.medium} tracking-wide ${isActivePath('/checks') ? 'font-semibold' : 'font-normal'}`}>
                  Checks
                </span>
              </Link>

              {/* Webhooks Tab */}
              <Link
                to="/webhooks"
                className={`flex flex-col items-center justify-center px-3 py-2 min-w-0 flex-1 ${theme.borderRadius.lg} ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${
                  isActivePath('/webhooks') 
                    ? `${theme.colors.background.hover} ${theme.colors.text.primary}` 
                    : `${theme.colors.text.secondary} hover:${theme.colors.text.primary} hover:${theme.colors.background.hover}`
                }`}
              >
                <div className="relative">
                  <FontAwesomeIcon 
                    icon="bell" 
                    className={`w-5 h-5 mb-1 ${isActivePath('/webhooks') ? 'opacity-100' : 'opacity-75'}`} 
                  />
                  {isActivePath('/webhooks') && (
                    <div className={`absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-1 h-1 ${theme.colors.text.primary} rounded-full`}></div>
                  )}
                </div>
                <span className={`text-xs ${theme.typography.fontWeight.medium} tracking-wide ${isActivePath('/webhooks') ? 'font-semibold' : 'font-normal'}`}>
                  Webhooks
                </span>
              </Link>

              {/* Logs Tab */}
              <Link
                to="/logs"
                className={`flex flex-col items-center justify-center px-3 py-2 min-w-0 flex-1 ${theme.borderRadius.lg} ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${
                  isActivePath('/logs')
                    ? `${theme.colors.background.hover} ${theme.colors.text.primary}` 
                    : `${theme.colors.text.secondary} hover:${theme.colors.text.primary} hover:${theme.colors.background.hover}`
                }`}
              >
                <div className="relative">
                  <FontAwesomeIcon 
                    icon="database" 
                    className={`w-5 h-5 mb-1 ${isActivePath('/logs') ? 'opacity-100' : 'opacity-75'}`} 
                  />
                  {isActivePath('/logs') && (
                    <div className={`absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-1 h-1 ${theme.colors.text.primary} rounded-full`}></div>
                  )}
                </div>
                <span className={`text-xs ${theme.typography.fontWeight.medium} tracking-wide ${isActivePath('/logs') ? 'font-semibold' : 'font-normal'}`}>
                  Logs
                </span>
              </Link>

              {/* Profile Tab */}
              <Link
                to="/profile"
                className={`flex flex-col items-center justify-center px-3 py-2 min-w-0 flex-1 ${theme.borderRadius.lg} ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${
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
                <span className={`text-xs ${theme.typography.fontWeight.medium} tracking-wide ${isActivePath('/profile') ? 'font-semibold' : 'font-normal'}`}>
                  Profile
                </span>
              </Link>

              {/* Sign Out Tab */}
              <button
                onClick={handleSignOut}
                className={`flex flex-col items-center justify-center px-3 py-2 min-w-0 flex-1 ${theme.borderRadius.lg} ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${theme.colors.text.secondary} hover:${theme.colors.text.primary} hover:${theme.colors.background.hover} cursor-pointer`}
              >
                <div className="relative">
                  <FontAwesomeIcon 
                    icon="arrow-right-from-bracket" 
                    className="w-5 h-5 mb-1 opacity-75" 
                  />
                </div>
                <span className={`text-xs ${theme.typography.fontWeight.medium} tracking-wide font-normal`}>
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