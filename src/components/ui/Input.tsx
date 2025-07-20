import React, { forwardRef } from 'react';
import { theme, typography } from '../../config/theme';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  touched?: boolean;
  helperText?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  variant?: 'default' | 'large' | 'small';
}

const Input = forwardRef<HTMLInputElement, InputProps>(({
  label,
  error,
  touched = false,
  helperText,
  leftIcon,
  rightIcon,
  variant = 'default',
  className = '',
  id,
  disabled,
  ...props
}, ref) => {
  const inputId = id || `input-${Math.random().toString(36).substr(2, 9)}`;
  const errorId = `${inputId}-error`;
  const helperId = `${inputId}-helper`;
  
  const hasError = Boolean(error && touched);
  const hasHelper = Boolean(helperText);
  
  // Get theme classes based on state and variant
  const getInputClasses = () => {
    // Variant-specific classes
    const variantClasses = {
      default: 'px-4 py-3 text-sm rounded-lg',
      large: 'px-6 py-4 text-base rounded-xl',
      small: 'px-3 py-2 text-xs rounded-md'
    };
    // State-specific classes
    let stateClasses = '';
    if (disabled) {
      stateClasses = theme.colors.input.disabled;
    } else if (hasError) {
      stateClasses = theme.colors.input.error;
    } else {
      stateClasses = [
        theme.colors.input.background,
        theme.colors.input.border,
        theme.colors.input.text
      ].join(' ');
    }
    const baseClasses = [
      'w-full',
      'border',
      typography.fontFamily.mono,
      'focus:outline-none',
      'focus:ring-2',
      'transition-colors',
      variantClasses[variant],
      stateClasses,
      leftIcon ? 'pl-10' : '',
      rightIcon ? 'pr-10' : '',
      className
    ];
    // Add hover classes if not disabled
    if (!disabled) {
      baseClasses.push(theme.colors.input.hover);
    }
    // Add focus classes if not disabled
    if (!disabled) {
      baseClasses.push(theme.colors.input.focus);
    }
    return baseClasses.join(' ');
  };
  
  const inputClasses = getInputClasses();

  // CSS to override Chrome autofill styles
  const autofillStyles = `
    input:-webkit-autofill,
    input:-webkit-autofill:hover,
    input:-webkit-autofill:focus,
    input:-webkit-autofill:active {
      -webkit-box-shadow: 0 0 0 30px rgb(0 0 0 / 0.6) inset !important;
      -webkit-text-fill-color: #ffffff !important;
      transition: background-color 5000s ease-in-out 0s;
    }
    
    input:-webkit-autofill:focus {
      -webkit-box-shadow: 0 0 0 30px rgb(0 0 0 / 0.8) inset !important;
    }
  `;

  return (
    <div className="space-y-2">
      <style>{autofillStyles}</style>
      {label && (
        <label 
          htmlFor={inputId}
          className={`block text-sm ${typography.fontFamily.body} ${theme.colors.text.primary} uppercase tracking-widest`}
        >
          {label}
        </label>
      )}
      
      <div className="relative">
        {leftIcon && (
          <div className={`absolute left-3 top-1/2 transform -translate-y-1/2 ${theme.colors.input.placeholder}`}>
            {leftIcon}
          </div>
        )}
        
        <input
          ref={ref}
          id={inputId}
          className={inputClasses}
          disabled={disabled}
          aria-describedby={`${hasError ? errorId : ''} ${hasHelper ? helperId : ''}`.trim()}
          aria-invalid={hasError ? 'true' : 'false'}
          {...props}
        />
        
        {rightIcon && (
          <div className={`absolute right-3 top-1/2 transform -translate-y-1/2 ${theme.colors.input.placeholder}`}>
            {rightIcon}
          </div>
        )}
      </div>
      
      {error && (
        <p className={`text-xs ${theme.colors.status.offline} ${typography.fontFamily.mono}`}>
          {error}
        </p>
      )}
      
      {hasHelper && !hasError && (
        <div 
          id={helperId}
          className={`text-xs ${theme.colors.text.muted} ${typography.fontFamily.body}`}
        >
          {helperText}
        </div>
      )}
    </div>
  );
});

Input.displayName = 'Input';

export default Input; 