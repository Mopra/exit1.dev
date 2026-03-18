import React from 'react';
import { Card } from './card';
import { Button } from './button';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from './empty';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  variant?: 'empty' | 'error' | 'loading' | 'search';
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: React.ComponentType<{ className?: string }>;
  };
  prominent?: boolean;
  className?: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({
  variant = 'empty',
  icon,
  title,
  description,
  action,
  prominent = false,
  className = ''
}) => {
  const getVariantStyles = () => {
    switch (variant) {
      case 'error':
        return {
          iconColor: 'text-red-400',
          titleColor: 'text-red-200',
          descriptionColor: 'text-red-300/70'
        };
      case 'loading':
        return {
          iconColor: 'text-blue-400',
          titleColor: 'text-blue-200',
          descriptionColor: 'text-blue-300/70'
        };
      case 'search':
        return {
          iconColor: 'text-gray-400',
          titleColor: 'text-gray-200',
          descriptionColor: 'text-gray-300/70'
        };
      default:
        return {
          iconColor: 'text-gray-400',
          titleColor: 'text-gray-200',
          descriptionColor: 'text-gray-300/70'
        };
    }
  };

  const styles = getVariantStyles();

  return (
    <Card className={cn("border-dashed border-2 m-1 sm:m-4 md:m-8 p-2 sm:p-4", className)}>
      <Empty className={cn("px-3 sm:px-8", prominent ? "py-8 sm:py-16" : "py-10 sm:py-16")}>
        <EmptyHeader>
          {icon && (
            <EmptyMedia variant="icon" className={cn(
              "rounded-full bg-gray-800/50",
              prominent ? "w-16 h-16 sm:w-20 sm:h-20" : "w-16 h-16",
              styles.iconColor
            )}>
              {React.createElement(icon, { className: prominent ? "w-8 h-8 sm:w-10 sm:h-10" : "w-8 h-8" })}
            </EmptyMedia>
          )}
          <EmptyTitle className={cn(
            styles.titleColor,
            prominent && "text-xl sm:text-2xl"
          )}>
            {title}
          </EmptyTitle>
          <EmptyDescription className={cn("max-w-md", styles.descriptionColor, prominent && "text-sm sm:text-base")}>
            {description}
          </EmptyDescription>
        </EmptyHeader>
        {action && (
          <EmptyContent className={prominent ? "mt-6 sm:mt-8" : undefined}>
            {prominent ? (
              <div className="relative group">
                {/* Animated glow border */}
                <div className="absolute -inset-1 rounded-xl bg-gradient-to-r from-emerald-500 via-cyan-500 to-emerald-500 opacity-60 blur-md animate-glow-pulse group-hover:opacity-90 transition-opacity duration-300" />
                <div className="absolute -inset-0.5 rounded-xl bg-gradient-to-r from-emerald-500 via-cyan-500 to-emerald-500 opacity-70 animate-glow-spin" />
                <Button
                  onClick={action.onClick}
                  size="lg"
                  className="relative px-5 py-4 text-base sm:px-8 sm:py-6 sm:text-lg font-semibold bg-gray-900 hover:bg-gray-800 text-white border-0 rounded-xl transition-all duration-200"
                >
                  {action.icon && React.createElement(action.icon, { className: "w-4 h-4 sm:w-5 sm:h-5 mr-2" })}
                  {action.label}
                </Button>
              </div>
            ) : (
              <Button onClick={action.onClick} variant="outline" size="sm">
                {action.icon && React.createElement(action.icon, { className: "w-4 h-4 mr-2" })}
                {action.label}
              </Button>
            )}
          </EmptyContent>
        )}
      </Empty>
    </Card>
  );
};

export default EmptyState;