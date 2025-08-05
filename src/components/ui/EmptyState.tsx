import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { faQuestionCircle } from '@fortawesome/free-regular-svg-icons';
import Button from './Button';
import { theme } from '../../config/theme';

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
        return `${theme.colors.background.card} ${theme.colors.text.muted} ${theme.shadows.glass}`;
      case 'empty':
        return `${theme.colors.background.card} ${theme.colors.text.primary} ${theme.shadows.glass}`;
      default:
        return `${theme.colors.background.card} ${theme.colors.text.muted} ${theme.shadows.glass}`;
    }
  };

  return (
    <div className={`text-center py-12 sm:py-20 ${className}`}>
      <div className={`mx-auto flex items-center justify-center h-16 sm:h-20 w-16 sm:w-20 rounded-full mb-6 sm:mb-8 ${getIconClasses()}`}>
        <FontAwesomeIcon icon={icon} className="text-blue-500 text-xl" />
      </div>
      <div className={`${theme.typography.fontSize.xl} sm:${theme.typography.fontSize['2xl']} ${theme.typography.fontWeight.medium} ${theme.colors.text.primary} mb-3 sm:mb-4`}>
        {title}
      </div>
      <div className={`${theme.typography.fontSize.base} ${theme.colors.text.muted} mb-6 sm:mb-8 max-w-md mx-auto leading-relaxed`}>
        {description}
      </div>
      {action && (
        <div className="flex flex-col gap-4 justify-center items-center">
          <Button
            onClick={action.onClick}
            variant="gradient"
            size="lg"
            className="flex items-center gap-3 px-8 py-3"
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