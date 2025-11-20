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
  className?: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({
  variant = 'empty',
  icon,
  title,
  description,
  action,
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
    <Card className={cn("border-dashed border-2 m-1 sm:m-8 p-4", className)}>
      <Empty className="py-16 px-8">
        <EmptyHeader>
          {icon && (
            <EmptyMedia variant="icon" className={cn("w-16 h-16 rounded-full bg-gray-800/50", styles.iconColor)}>
              {React.createElement(icon, { className: "w-8 h-8" })}
            </EmptyMedia>
          )}
          <EmptyTitle className={styles.titleColor}>
            {title}
          </EmptyTitle>
          <EmptyDescription className={cn("max-w-md", styles.descriptionColor)}>
            {description}
          </EmptyDescription>
        </EmptyHeader>
        {action && (
          <EmptyContent>
            <Button onClick={action.onClick} variant="outline" size="sm">
              {action.icon && React.createElement(action.icon, { className: "w-4 h-4 mr-2" })}
              {action.label}
            </Button>
          </EmptyContent>
        )}
      </Empty>
    </Card>
  );
};

export default EmptyState; 