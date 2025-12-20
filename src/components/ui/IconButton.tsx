import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button } from './button';

type IconButtonProps = Omit<React.ComponentPropsWithoutRef<typeof Button>, 'children'> & {
  icon: React.ReactNode | LucideIcon;
};

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      icon,
      variant = 'ghost',
      size = 'icon',
      className,
      type,
      ...props
    },
    ref
  ) => {
    return (
      <Button
        ref={ref}
        type={type ?? "button"}
        variant={variant}
        size={size}
        className={className}
        {...props}
      >
        {typeof icon === 'function' ? (
          // LucideIcon passed as component
          React.createElement(icon as LucideIcon, { className: 'w-4 h-4' })
        ) : (
          icon
        )}
      </Button>
    );
  }
);
IconButton.displayName = 'IconButton';

export default IconButton;