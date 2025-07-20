import React from 'react';
import { theme, typography } from '../../config/theme';

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ReactNode;
  variant?: 'default' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  'aria-label': string;
}

const IconButton: React.FC<IconButtonProps> = React.memo(({
  icon,
  variant = 'default',
  size = 'md',
  className = '',
  disabled,
  ...props
}) => {
  const baseClasses = `inline-flex items-center justify-center ${typography.fontFamily.mono} transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-black rounded-sm disabled:cursor-not-allowed`;
  
  const variantClasses = {
    default: [
      theme.colors.iconButton.default.background,
      theme.colors.iconButton.default.text,
      theme.colors.iconButton.default.hover,
      theme.colors.iconButton.default.disabled,
      theme.colors.iconButton.default.focus,
      'cursor-pointer'
    ].join(' '),
    ghost: [
      theme.colors.iconButton.ghost.background,
      theme.colors.iconButton.ghost.text,
      theme.colors.iconButton.ghost.hover,
      theme.colors.iconButton.ghost.disabled,
      theme.colors.iconButton.ghost.focus,
      'cursor-pointer'
    ].join(' '),
    danger: [
      theme.colors.iconButton.danger.background,
      theme.colors.iconButton.danger.text,
      theme.colors.iconButton.danger.hover,
      theme.colors.iconButton.danger.disabled,
      theme.colors.iconButton.danger.focus,
      'cursor-pointer'
    ].join(' ')
  };
  
  const sizeClasses = {
    sm: 'w-8 h-8 text-sm',
    md: 'w-10 h-10 text-base',
    lg: 'w-12 h-12 text-lg'
  };

  const classes = `${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`;

  return (
    <button
      className={classes}
      disabled={disabled}
      {...props}
    >
      {icon}
    </button>
  );
});

IconButton.displayName = 'IconButton';

export default IconButton; 