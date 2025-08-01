import React from 'react';
import { colors, typography } from '../../config/theme';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'gradient';
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
    'transition-all',
    'duration-200',
    'focus:outline-none',
    'focus:ring-2',
    'focus:ring-offset-2',
    'focus:ring-offset-black',
    'rounded-xl',
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
    ].join(' '),
    gradient: [
      colors.button.gradient.background,
      colors.button.gradient.text,
      colors.button.gradient.hover,
      colors.button.gradient.disabled,
      colors.button.gradient.focus
    ].join(' ')
  };

  // Size-specific styles
  const sizeClasses = {
    sm: 'px-4 py-2 text-xs',
    md: 'px-6 py-3.5',
    lg: 'px-8 py-5'
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