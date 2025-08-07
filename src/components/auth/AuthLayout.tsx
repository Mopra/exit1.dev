import React from 'react';
import { Card } from '../ui';
interface AuthLayoutProps {
  children: React.ReactNode;
  title: string;
  variant?: 'signin' | 'signup';
  outerClassName?: string;
}

const AuthLayout: React.FC<AuthLayoutProps> = ({ children, title, variant = 'signin', outerClassName = '' }) => {
  return (
    <div className={`min-h-screen text-foreground font-sans flex items-start justify-center pt-20 ${outerClassName}`}>
      <Card className={`w-full max-w-md border relative overflow-hidden backdrop-blur-sm animate-in fade-in duration-500 group hover:scale-[1.02] transition-transform duration-300`}>
        {/* Accent line based on variant */}
        <div className={`absolute top-0 left-0 right-0 h-1 ${variant === 'signin' ? 'bg-blue-600/50 hover:bg-blue-500/70' : 'bg-green-600/50 hover:bg-green-500/70'} transition-all duration-300 group-hover:h-1.5`}></div>
        <div className="p-8">
          <h1 className={`text-3xl font-bold tracking-widest uppercase mb-2 text-foreground font-mono text-center`}>
            exit1.dev
          </h1>
          <p className={`text-sm text-muted-foreground tracking-widest text-center mb-8`}>
            Website Monitoring Platform
          </p>
          {/* Subtle indicator */}
          <div className={`text-xs text-center mb-4 opacity-60 ${variant === 'signin' ? 'text-blue-400' : 'text-green-400'}`}>
            {variant === 'signin' ? 'Welcome back' : 'Join the platform'}
          </div>
          <h2 className={`text-xl font-medium mb-6 text-center flex items-center justify-center gap-2`}>
            {variant === 'signin' && (
              <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
              </svg>
            )}
            {variant === 'signup' && (
              <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
            )}
            {title}
          </h2>
          {children}
        </div>
      </Card>
    </div>
  );
};

export default AuthLayout; 