import React from 'react';
import { Card } from './Card';
import { Button } from './Button';
import StarBorder from './StarBorder';
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
          iconColor: 'text-destructive',
          titleColor: 'text-destructive',
          descriptionColor: 'text-destructive/70'
        };
      case 'loading':
        return {
          iconColor: 'text-primary',
          titleColor: 'text-primary',
          descriptionColor: 'text-primary/70'
        };
      case 'search':
      default:
        return {
          iconColor: 'text-muted-foreground',
          titleColor: 'text-foreground',
          descriptionColor: 'text-muted-foreground'
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
              <StarBorder
                as="button"
                type="button"
                onClick={action.onClick}
                color="var(--primary)"
                speed="2.5s"
                thickness={3}
                className="cursor-pointer"
              >
                <div className="flex items-center justify-center px-5 py-4 sm:px-8 sm:py-6 text-base sm:text-lg font-semibold bg-black hover:bg-primary/20 text-primary-foreground border border-primary rounded-[18px] transition-colors duration-200">
                  {action.icon && React.createElement(action.icon, { className: "w-4 h-4 sm:w-5 sm:h-5 mr-2" })}
                  {action.label}
                </div>
              </StarBorder>
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