import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { Button } from '../ui';
import { ArrowLeft, LogIn, ExternalLink, MessageCircle } from 'lucide-react';

export const PublicPageHeader: React.FC = () => {
  const { isSignedIn } = useAuth();

  return (
    <header className="sticky top-0 z-50 isolate border-b border-border/40 bg-background [background-image:none] flex-shrink-0">
      <div className="w-full mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Left: brand for signed-out users, back-to-app for signed-in users */}
          {isSignedIn ? (
            <Button
              variant="ghost"
              asChild
              className="cursor-pointer -ml-3 gap-2"
            >
              <Link to="/" className="flex items-center">
                <ArrowLeft className="w-4 h-4" />
                Back to app
              </Link>
            </Button>
          ) : (
            <Link
              to="/"
              className="text-xl font-bold text-foreground hover:text-muted-foreground transition-colors cursor-pointer"
            >
              exit1.dev
            </Link>
          )}

          {/* Right: contextual nav */}
          <nav className="flex items-center gap-1 sm:gap-2">
            {!isSignedIn && (
              <Button variant="ghost" asChild className="cursor-pointer">
                <Link to="/login">
                  <LogIn className="w-4 h-4 mr-2" />
                  Login
                </Link>
              </Button>
            )}
            <Button variant="ghost" asChild className="cursor-pointer">
              <a
                href="https://exit1.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center"
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                <span className="hidden sm:inline">Website</span>
              </a>
            </Button>
            <Button variant="ghost" asChild className="cursor-pointer">
              <a
                href="https://discord.com/invite/uZvWbpwJZS"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center"
              >
                <MessageCircle className="w-4 h-4 mr-2" />
                <span className="hidden sm:inline">Discord</span>
              </a>
            </Button>
          </nav>
        </div>
      </div>
    </header>
  );
};
