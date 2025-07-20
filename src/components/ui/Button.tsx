import React from 'react';
import { colors, typography } from '../../config/theme';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  children: React.ReactNode;
}

const Button: React.FC<ButtonProps> = React.memo(({
  variant = 'primary',
  size = 'md',
  className = '',
  disabled,
  children,
  ...props
}) => {
  // Base styles applied to all buttons
  const baseClasses = [
    typography.fontFamily.mono,
    'text-sm',
    'uppercase',
    'tracking-widest',
    'transition-colors',
    'focus:outline-none',
    'focus:ring-2',
    'focus:ring-offset-2',
    'focus:ring-offset-black',
    'rounded-sm',
    'disabled:cursor-not-allowed',
    'cursor-pointer'
  ].join(' ');

  // Variant-specific styles using theme configuration
  const variantClasses = {
    primary: [
      colors.button.primary.background,
      colors.button.primary.text,
      colors.button.primary.hover,
      colors.button.primary.disabled
    ].join(' '),
    secondary: [
      colors.button.secondary.background,
      colors.button.secondary.text,
      colors.button.secondary.hover,
      colors.button.secondary.disabled
    ].join(' '),
    danger: [
      colors.button.danger.background,
      colors.button.danger.text,
      colors.button.danger.hover,
      colors.button.danger.disabled
    ].join(' '),
    ghost: [
      colors.button.ghost.background,
      colors.button.ghost.text,
      colors.button.ghost.hover,
      colors.button.ghost.disabled
    ].join(' ')
  };

  // Size-specific styles
  const sizeClasses = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2',
    lg: 'px-6 py-3'
  };

  // Combine all classes
  const classes = `${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`;

  return (
    <button
      className={classes}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
});

Button.displayName = 'Button';

export default Button; 