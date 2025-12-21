import React from 'react';
import { Link } from 'react-router-dom';
import { PageContainer } from '@/components/layout';
import { Button } from '@/components/ui';
import { LogIn, ExternalLink, MessageCircle } from 'lucide-react';

interface ReleaseNote {
  date: string;
  title: string;
  content: React.ReactNode;
}

// Release notes data - easily updateable
const releaseNotes: ReleaseNote[] = [
  {
    date: '2024-01-15',
    title: 'Initial Release',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Welcome to exit1.dev! We're excited to share our first release.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Website uptime monitoring</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Status page generation</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Email notifications</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Public status pages</span>
          </li>
        </ul>
      </>
    ),
  },
];

const ReleaseNotes: React.FC = () => {
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Topbar */}
      <header className="sticky top-0 z-50 border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
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

      {/* Content */}
      <PageContainer>
        <div className="max-w-3xl mx-auto py-16 px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-16">
          <h1 className="text-4xl font-bold mb-3">What's New</h1>
          <p className="text-lg text-muted-foreground">
            Keep up with the latest releases, improvements, and fixes.
          </p>
        </div>

        {/* Release Notes List */}
        <div className="space-y-16">
          {releaseNotes.map((release, index) => (
            <article key={index} className="space-y-4">
              <time className="text-sm text-muted-foreground block">
                {formatDate(release.date)}
              </time>
              <h2 className="text-2xl font-semibold leading-tight">
                {release.title}
              </h2>
              <div className="prose prose-sm max-w-none text-foreground">
                {release.content}
              </div>
            </article>
          ))}
        </div>

        {/* Empty State */}
        {releaseNotes.length === 0 && (
          <div className="text-center py-16">
            <p className="text-muted-foreground">No release notes yet. Check back soon!</p>
          </div>
        )}
        </div>
      </PageContainer>
    </div>
  );
};

export default ReleaseNotes;
