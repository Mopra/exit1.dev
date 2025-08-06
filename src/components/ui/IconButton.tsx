import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { Button } from './button';

interface IconButtonProps {
  icon: IconDefinition | React.ReactNode;
  onClick: (e?: React.MouseEvent) => void;
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  disabled?: boolean;
  className?: string;
  title?: string;
}

const IconButton: React.FC<IconButtonProps> = ({
  icon,
  onClick,
  variant = 'ghost',
  size = 'icon',
  disabled = false,
  className = '',
  title
}) => {
  return (
    <Button
      variant={variant}
      size={size}
      onClick={onClick}
      disabled={disabled}
      className={className}
      title={title}
    >
      {typeof icon === 'object' && icon && 'icon' in icon ? (
        <FontAwesomeIcon icon={icon as IconDefinition} className="w-4 h-4" />
      ) : (
        icon
      )}
    </Button>
  );
};

export default IconButton; 