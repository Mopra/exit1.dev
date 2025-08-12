import React from 'react';
import { Card, CardContent } from './card';
import { Button } from './button';

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
    <Card className={`border-dashed border-2 m-1 sm:m-8 p-4${className}`}>
      <CardContent className="flex flex-col items-center justify-center py-16 px-8 text-center">
        {icon && (
          <div className={`w-16 h-16 rounded-full bg-gray-800/50 flex items-center justify-center mb-4 ${styles.iconColor}`}>
            {React.createElement(icon, { className: "w-8 h-8" })}
          </div>
        )}
        <h3 className={`text-lg font-semibold mb-2 ${styles.titleColor}`}>
          {title}
        </h3>
        <p className={`text-sm max-w-md ${styles.descriptionColor}`}>
          {description}
        </p>
        {action && (
          <div className="mt-4">
            <Button onClick={action.onClick} variant="outline" size="sm">
              {action.icon && React.createElement(action.icon, { className: "w-4 h-4 mr-2" })}
              {action.label}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default EmptyState; 