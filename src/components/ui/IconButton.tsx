import React from 'react';
import { Button } from './button';
import type { LucideIcon } from 'lucide-react';

interface IconButtonProps {
  icon: LucideIcon | React.ReactNode;
  onClick: (e?: React.MouseEvent) => void;
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  disabled?: boolean;
  className?: string;
  title?: string;
}

const IconButton: React.FC<IconButtonProps> = ({
  icon: Icon,
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
      {typeof Icon === 'function' ? (
        <Icon className="w-4 h-4" />
      ) : (
        Icon
      )}
    </Button>
  );
};

export default IconButton; 