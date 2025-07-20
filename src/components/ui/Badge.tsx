import React from 'react';
import { theme, typography } from '../../config/theme';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
  size?: 'sm' | 'md';
}

const Badge: React.FC<BadgeProps> = React.memo(({
  children,
  variant = 'default',
  size = 'md',
  className = '',
  ...props
}) => {
  const baseClasses = `inline-flex items-center ${typography.fontFamily.mono} text-md uppercase tracking-wider rounded-sm`;
  
  const variantClasses = {
    default: theme.colors.badge.default,
    primary: theme.colors.badge.primary,
    success: theme.colors.badge.success,
    warning: theme.colors.badge.warning,
    error: theme.colors.badge.error,
    info: theme.colors.badge.info
  };
  
  const sizeClasses = {
    sm: 'px-2 py-0.5',
    md: 'px-2.5 py-1'
  };

  const classes = `${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`;

  return (
    <span className={classes} {...props}>
      {children}
    </span>
  );
});

Badge.displayName = 'Badge';

export default Badge; 