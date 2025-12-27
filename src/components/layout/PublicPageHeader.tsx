import React from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../ui';
import { LogIn, ExternalLink, MessageCircle } from 'lucide-react';

export const PublicPageHeader: React.FC = () => {
  return (
    <header className="sticky top-0 z-50 border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 flex-shrink-0">
      <div className="w-full mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link
            to="/"
            className="text-xl font-bold text-foreground hover:text-muted-foreground transition-colors cursor-pointer"
          >
            exit1.dev
          </Link>

          {/* Navigation Links */}
          <nav className="flex items-center gap-4">
            <Button
              variant="ghost"
              asChild
              className="cursor-pointer"
            >
              <Link to="/login">
                <LogIn className="w-4 h-4 mr-2" />
                Login
              </Link>
            </Button>
            <Button
              variant="ghost"
              asChild
              className="cursor-pointer"
            >
              <a
                href="https://exit1.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center"
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                Website
              </a>
            </Button>
            <Button
              variant="ghost"
              asChild
              className="cursor-pointer"
            >
              <a
                href="https://discord.com/invite/uZvWbpwJZS"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center"
              >
                <MessageCircle className="w-4 h-4 mr-2" />
                Discord
              </a>
            </Button>
          </nav>
        </div>
      </div>
    </header>
  );
};

