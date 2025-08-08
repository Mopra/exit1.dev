import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button } from './button';

interface IconButtonProps {
  icon: React.ReactNode | LucideIcon;
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
      {typeof icon === 'function' ? (
        // LucideIcon passed as component
        React.createElement(icon as LucideIcon, { className: 'w-4 h-4' })
      ) : (
        icon
      )}
    </Button>
  );
};

export default IconButton; 