import { Link, useLocation } from 'react-router-dom';
import { useAuth, useClerk } from '@clerk/clerk-react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faChevronRight, faGlobe, faBell, faDatabase, faUser, faArrowRightFromBracket } from '@fortawesome/free-solid-svg-icons';
import { theme, typography } from '../../config/theme';

interface SideNavProps {
  isCollapsed: boolean;
  setIsCollapsed: (collapsed: boolean) => void;
}

const SideNav = ({ isCollapsed, setIsCollapsed }: SideNavProps) => {
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

  if (!isSignedIn) {
    return null;
  }

  const navItems = [
    {
      path: '/checks',
      icon: faGlobe,
      label: 'Checks',
      description: 'Monitor websites'
    },
    {
      path: '/webhooks',
      icon: faBell,
      label: 'Webhooks',
      description: 'Notifications'
    },
    {
      path: '/logs',
      icon: faDatabase,
      label: 'Logs',
      description: 'Activity history'
    },
    {
      path: '/profile',
      icon: faUser,
      label: 'Profile',
      description: 'Account settings'
    }
  ];

  return (
    <>
      {/* Side Navigation */}
      <div className={`fixed left-0 top-0 h-screen ${isCollapsed ? 'w-16' : 'w-64'} ${theme.colors.background.card} rounded-t-xl ${theme.shadows.lg} z-50 grid grid-rows-[auto_auto_1fr_auto] transition-all duration-300 overflow-hidden border-r ${theme.colors.border.primary}`}>
        
        {/* HEAD SECTION - Top */}
        <div className="row-start-1">
          {/* Logo Section */}
          <div className={`p-4 border-b ${theme.colors.border.primary} flex items-center justify-between`}>
            {!isCollapsed && (
              <Link 
                to="/" 
                className={`text-xl font-bold ${theme.colors.text.primary} hover:${theme.colors.text.secondary} ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${typography.fontFamily.display}`}
              >
                exit1.dev
              </Link>
            )}
            <button
              onClick={() => setIsCollapsed(!isCollapsed)}
              className={`p-2 rounded-lg ${theme.colors.text.secondary} hover:${theme.colors.text.primary} hover:${theme.colors.background.hover} ${theme.animation.transition.colors} ${theme.animation.duration[200]} cursor-pointer`}
            >
              <FontAwesomeIcon icon={isCollapsed ? faChevronRight : faChevronLeft} className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* MID SECTION - Navigation Items (Right below HEAD) */}
        <div className="row-start-2 p-2 space-y-1 pb-20 overflow-hidden">
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-3 px-3 py-3 rounded-lg ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${
                isActivePath(item.path)
                  ? `${theme.colors.background.hover} ${theme.colors.text.primary}`
                  : `${theme.colors.text.secondary} hover:${theme.colors.text.primary} ${theme.colors.background.hover}`
              } cursor-pointer`}
              title={isCollapsed ? item.label : undefined}
            >
              <FontAwesomeIcon 
                icon={item.icon} 
                className={`w-4 h-4 ${isActivePath(item.path) ? 'opacity-100' : 'opacity-75'}`} 
              />
              <div className={`flex-1 min-w-0 transition-all duration-300 ${
                isCollapsed 
                  ? 'opacity-0 scale-95 translate-x-2 pointer-events-none' 
                  : 'opacity-100 scale-100 translate-x-0'
              }`}>
                <div className={`${typography.fontWeight.medium} ${isActivePath(item.path) ? 'font-semibold' : 'font-medium'}`}>
                  {item.label}
                </div>
                <div className={`text-xs ${theme.colors.text.muted} truncate`}>
                  {item.description}
                </div>
              </div>
              <div className={`w-1 h-6 ${theme.colors.text.primary} rounded-full transition-all duration-300 ${
                !isCollapsed && isActivePath(item.path)
                  ? 'opacity-100 scale-100' 
                  : 'opacity-0 scale-0'
              }`}></div>
            </Link>
          ))}
        </div>

        {/* FOOT SECTION - Bottom */}
        <div className="absolute bottom-0 left-0 right-0">
          {/* Sign Out Section */}
          <div className={`p-2 border-t ${theme.colors.border.primary} ${theme.colors.background.card}`}>
            <button
              onClick={handleSignOut}
              className={`flex items-center gap-3 px-3 py-3 w-full rounded-lg ${theme.colors.text.secondary} hover:${theme.colors.text.primary} ${theme.colors.background.hover} ${theme.animation.transition.colors} ${theme.animation.duration[200]} cursor-pointer`}
              title={isCollapsed ? 'Sign out' : undefined}
            >
              <FontAwesomeIcon icon={faArrowRightFromBracket} className="w-4 h-4 opacity-75" />
              <span className={`${typography.fontWeight.medium} transition-all duration-300 ${
                isCollapsed 
                  ? 'opacity-0 scale-95 translate-x-2 pointer-events-none' 
                  : 'opacity-100 scale-100 translate-x-0'
              }`}>
                Sign Out
              </span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default SideNav; 