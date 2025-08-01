import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { faQuestionCircle } from '@fortawesome/pro-regular-svg-icons';
import Button from './Button';
import { theme, typography } from '../../config/theme';

interface EmptyStateProps {
  icon?: IconDefinition;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: IconDefinition;
  };
  variant?: 'default' | 'search' | 'empty';
  className?: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({
  icon = faQuestionCircle,
  title,
  description,
  action,
  variant = 'default',
  className = ''
}) => {
  const getIconClasses = () => {
    switch (variant) {
      case 'search':
        return 'bg-gray-100 text-gray-600';
      case 'empty':
        return 'bg-blue-100 text-blue-600';
      default:
        return 'bg-gray-100 text-gray-600';
    }
  };

  return (
    <div className={`text-center py-8 sm:py-16 ${className}`}>
      <div className={`mx-auto flex items-center justify-center h-12 sm:h-16 w-12 sm:w-16 rounded-full mb-4 sm:mb-6 ${getIconClasses()}`}>
        <FontAwesomeIcon icon={icon} className="h-6 sm:h-8 w-6 sm:w-8" />
      </div>
      <div className={`text-lg sm:text-xl font-medium ${theme.colors.text.primary} mb-2 sm:mb-3`}>
        {title}
      </div>
      <div className={`text-sm ${theme.colors.text.muted} mb-4 sm:mb-6 max-w-md mx-auto`}>
        {description}
      </div>
      {action && (
        <div className="flex flex-col gap-4 justify-center items-center">
          <Button
            onClick={action.onClick}
            variant="primary"
            size="lg"
            className="flex items-center gap-2"
          >
            {action.icon && <FontAwesomeIcon icon={action.icon} className="w-4 h-4" />}
            {action.label}
          </Button>
        </div>
      )}
    </div>
  );
};

export default EmptyState; 