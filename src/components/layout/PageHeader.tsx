import React from 'react';
import { type LucideIcon } from 'lucide-react';

interface PageHeaderProps {
  title: string | React.ReactNode;
  description?: string;
  actions?: React.ReactNode;
  icon?: LucideIcon;
}

export const PageHeader: React.FC<PageHeaderProps> = ({ title, description, actions, icon: Icon }) => {
  return (
    <div className="w-full mb-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="w-full mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-4 py-2 sm:py-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg sm:text-xl font-semibold tracking-tight flex items-center gap-2">
              {Icon && <Icon className="w-4 h-4 shrink-0" />}
              {title}
            </h1>
            {description && (
              <p className="text-sm text-muted-foreground hidden sm:block">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      </div>
    </div>
  );
};

