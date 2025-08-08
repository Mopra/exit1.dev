import { Link, useLocation } from 'react-router-dom';
import { useAuth, useClerk } from '@clerk/clerk-react';
import { ChevronLeft, ChevronRight, Globe, Webhook, Database, User, LogOut } from 'lucide-react';
import { Button, Card, CardContent } from '../ui';

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
      icon: Globe,
      label: 'Checks',
      description: 'Monitor websites'
    },
    {
      path: '/webhooks',
      icon: Webhook,
      label: 'Webhooks',
      description: 'Notifications'
    },
    {
      path: '/logs',
      icon: Database,
      label: 'Logs',
      description: 'Activity history'
    },
    {
      path: '/profile',
      icon: User,
      label: 'Profile',
      description: 'Account settings'
    }
  ];

  return (
    <>
      {/* Side Navigation */}
      <Card className={`fixed left-0 top-0 h-screen ${isCollapsed ? 'w-16' : 'w-64'} z-50 grid grid-rows-[auto_auto_1fr_auto] transition-all duration-300 overflow-hidden border-r rounded-t-xl shadow-lg`}>
        
        {/* HEAD SECTION - Top */}
        <div className="row-start-1">
          {/* Logo Section */}
          <CardContent className="p-4 border-b flex items-center justify-between">
            {!isCollapsed && (
              <Link 
                to="/" 
                className="text-xl font-bold text-foreground hover:text-muted-foreground transition-colors duration-200 font-display"
              >
                exit1.dev
              </Link>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsCollapsed(!isCollapsed)}
              className="p-2 h-auto"
            >
              {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            </Button>
          </CardContent>
        </div>

        {/* MID SECTION - Navigation Items (Right below HEAD) */}
        <div className="row-start-2 p-2 space-y-1 pb-20 overflow-hidden">
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-3 px-3 py-3 rounded-lg transition-colors duration-200 ${
                isActivePath(item.path)
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-gray-50 dark:hover:bg-gray-950/20'
              } cursor-pointer`}
              title={isCollapsed ? item.label : undefined}
            >
              <item.icon 
                className={`w-4 h-4 ${isActivePath(item.path) ? 'opacity-100' : 'opacity-75'}`} 
              />
              <div className={`flex-1 min-w-0 transition-all duration-300 ${
                isCollapsed 
                  ? 'opacity-0 scale-95 translate-x-2 pointer-events-none' 
                  : 'opacity-100 scale-100 translate-x-0'
              }`}>
                <div className={`font-medium ${isActivePath(item.path) ? 'font-semibold' : 'font-medium'}`}>
                  {item.label}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {item.description}
                </div>
              </div>
              <div className={`w-1 h-6 bg-foreground rounded-full transition-all duration-300 ${
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
          <CardContent className="p-2 border-t">
            <Button
              variant="ghost"
              onClick={handleSignOut}
              className="flex items-center gap-3 px-3 py-3 w-full h-auto justify-start"
              title={isCollapsed ? 'Sign out' : undefined}
            >
              <LogOut className="w-4 h-4 opacity-75" />
              <span className={`font-medium transition-all duration-300 ${
                isCollapsed 
                  ? 'opacity-0 scale-95 translate-x-2 pointer-events-none' 
                  : 'opacity-100 scale-100 translate-x-0'
              }`}>
                Sign Out
              </span>
            </Button>
          </CardContent>
        </div>
      </Card>
    </>
  );
};

export default SideNav; 