import { Link, useLocation } from 'react-router-dom';
import { useAuth, useClerk } from '@clerk/clerk-react';
import { Globe, Webhook, Database, User, LogOut } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Button, Card, CardContent } from '../ui';

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
      <header className="sticky top-4 z-[40] lg:block hidden">
        <Card className="py-4 px-6 mx-4 rounded-xl shadow-lg">
          <CardContent className="p-0">
            <div className="flex items-center justify-between gap-8">
              {/* Left side - Logo and Brand */}
              <div className="flex items-center">
                <Link to="/" className="text-2xl font-bold text-foreground hover:text-muted-foreground transition-colors duration-200">
                  exit1.dev
                </Link>
              </div>

              {/* Desktop Navigation */}
              {isSignedIn && (
                <nav className="flex items-center gap-6">
                  <Button
                    variant="ghost"
                    asChild
                    className="flex items-center gap-2"
                  >
                    <Link to="/checks">
                      <Globe className="w-4 h-4" />
                      <span>Checks</span>
                    </Link>
                  </Button>
                  <Button
                    variant="ghost"
                    asChild
                    className="flex items-center gap-2"
                  >
                    <Link to="/webhooks">
                      <Webhook className="w-4 h-4" />
                      <span>Webhooks</span>
                    </Link>
                  </Button>
                  <Button
                    variant="ghost"
                    asChild
                    className="flex items-center gap-2"
                  >
                    <Link to="/logs">
                      <Database className="w-4 h-4" />
                      <span>Logs</span>
                    </Link>
                  </Button>
                  <Button
                    variant="ghost"
                    asChild
                    className="flex items-center gap-2"
                  >
                    <Link to="/profile">
                      <User className="w-4 h-4" />
                      <span>Profile</span>
                    </Link>
                  </Button>
                  
                  {/* Desktop Logout button */}
                  <Button
                    variant="ghost"
                    onClick={handleSignOut}
                    className="flex items-center gap-2"
                    title="Sign out"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Sign Out</span>
                  </Button>
                </nav>
              )}
            </div>
          </CardContent>
        </Card>
      </header>

      {/* Mobile Floating Header */}
      <header className="lg:hidden sticky top-4 z-[40]">
        <Card className="py-4 px-6 mx-4 rounded-xl shadow-lg">
          <CardContent className="p-0">
            <div className="flex items-center justify-center">
              <Link to="/" className="text-xl font-bold text-foreground">
                exit1.dev
              </Link>
            </div>
          </CardContent>
        </Card>
      </header>

      {/* Content Padding to Account for Floating Headers */}
      <div className="lg:block hidden h-28"></div>
      {isSignedIn && <div className="lg:hidden h-24"></div>}

      {/* Mobile Bottom Navigation - Rendered as Portal */}
      {isSignedIn && createPortal(
        <div className="lg:hidden fixed bottom-4 left-4 right-4 z-[30]">
          <Card className="px-2 py-2 w-full rounded-xl shadow-lg">
            <CardContent className="p-0">
              <nav className="flex items-center justify-around max-w-lg mx-auto">
                
                {/* Checks Tab */}
                <Button
                  variant="ghost"
                  asChild
                  className={`flex flex-col items-center justify-center px-3 py-2 min-w-0 flex-1 h-auto ${
                    isActivePath('/checks') 
                      ? 'bg-accent text-accent-foreground' 
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                >
                  <Link to="/checks">
                    <div className="relative">
                      <Globe 
                        className={`w-5 h-5 mb-1 ${isActivePath('/checks') ? 'opacity-100' : 'opacity-75'}`} 
                      />
                      {isActivePath('/checks') && (
                        <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-1 h-1 bg-foreground rounded-full"></div>
                      )}
                    </div>
                    <span className={`text-xs font-medium tracking-wide ${isActivePath('/checks') ? 'font-semibold' : 'font-normal'}`}>
                      Checks
                    </span>
                  </Link>
                </Button>

                {/* Webhooks Tab */}
                <Button
                  variant="ghost"
                  asChild
                  className={`flex flex-col items-center justify-center px-3 py-2 min-w-0 flex-1 h-auto ${
                    isActivePath('/webhooks') 
                      ? 'bg-accent text-accent-foreground' 
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                >
                  <Link to="/webhooks">
                    <div className="relative">
                      <Webhook 
                        className={`w-5 h-5 mb-1 ${isActivePath('/webhooks') ? 'opacity-100' : 'opacity-75'}`} 
                      />
                      {isActivePath('/webhooks') && (
                        <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-1 h-1 bg-foreground rounded-full"></div>
                      )}
                    </div>
                    <span className={`text-xs font-medium tracking-wide ${isActivePath('/webhooks') ? 'font-semibold' : 'font-normal'}`}>
                      Webhooks
                    </span>
                  </Link>
                </Button>

                {/* Logs Tab */}
                <Button
                  variant="ghost"
                  asChild
                  className={`flex flex-col items-center justify-center px-3 py-2 min-w-0 flex-1 h-auto ${
                    isActivePath('/logs')
                      ? 'bg-accent text-accent-foreground' 
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                >
                  <Link to="/logs">
                    <div className="relative">
                      <Database 
                        className={`w-5 h-5 mb-1 ${isActivePath('/logs') ? 'opacity-100' : 'opacity-75'}`} 
                      />
                      {isActivePath('/logs') && (
                        <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-1 h-1 bg-foreground rounded-full"></div>
                      )}
                    </div>
                    <span className={`text-xs font-medium tracking-wide ${isActivePath('/logs') ? 'font-semibold' : 'font-normal'}`}>
                      Logs
                    </span>
                  </Link>
                </Button>

                {/* Profile Tab */}
                <Button
                  variant="ghost"
                  asChild
                  className={`flex flex-col items-center justify-center px-3 py-2 min-w-0 flex-1 h-auto ${
                    isActivePath('/profile') 
                      ? 'bg-accent text-accent-foreground' 
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                >
                  <Link to="/profile">
                    <div className="relative">
                      <User 
                        className={`w-5 h-5 mb-1 ${isActivePath('/profile') ? 'opacity-100' : 'opacity-75'}`} 
                      />
                      {isActivePath('/profile') && (
                        <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-1 h-1 bg-foreground rounded-full"></div>
                      )}
                    </div>
                    <span className={`text-xs font-medium tracking-wide ${isActivePath('/profile') ? 'font-semibold' : 'font-normal'}`}>
                      Profile
                    </span>
                  </Link>
                </Button>

                {/* Sign Out Tab */}
                <Button
                  variant="ghost"
                  onClick={handleSignOut}
                  className="flex flex-col items-center justify-center px-3 py-2 min-w-0 flex-1 h-auto text-muted-foreground hover:text-foreground hover:bg-accent"
                >
                  <div className="relative">
                    <LogOut 
                      className="w-5 h-5 mb-1 opacity-75" 
                    />
                  </div>
                  <span className="text-xs font-medium tracking-wide font-normal">
                    Sign Out
                  </span>
                </Button>

              </nav>
            </CardContent>
          </Card>
        </div>,
        document.body
      )}
    </>
  );
};

export default Header; 