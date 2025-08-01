import React, { forwardRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { theme, typography } from '../../config/theme';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  touched?: boolean;
  helperText?: string;
  options: SelectOption[];
  leftIcon?: React.ReactNode;
  variant?: 'default' | 'large' | 'small';
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(({
  label,
  error,
  touched = false,
  helperText,
  options,
  leftIcon,
  variant = 'default',
  className = '',
  id,
  disabled,
  ...props
}, ref) => {
  const selectId = id || `select-${Math.random().toString(36).substr(2, 9)}`;
  const errorId = `${selectId}-error`;
  const helperId = `${selectId}-helper`;
  
  const hasError = Boolean(error && touched);
  const hasHelper = Boolean(helperText);
  
  // Track select open state for arrow animation
  const [isOpen, setIsOpen] = useState(false);
  
  // Get theme classes based on state and variant
  const getSelectClasses = () => {
    // Variant-specific classes
    const variantClasses = {
      default: 'px-4 py-3 text-sm rounded-2xl',
      large: 'px-6 py-4 text-base rounded-3xl',
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
      'cursor-pointer',
      'appearance-none',
      variantClasses[variant],
      stateClasses,
      leftIcon ? 'pl-10' : '',
      'pr-10',
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
  
  const selectClasses = getSelectClasses();

  return (
    <div className="space-y-2">
      {label && (
        <label 
          htmlFor={selectId}
          className={`block text-sm ${typography.fontFamily.body} ${theme.colors.text.primary} uppercase tracking-widest`}
        >
          {label}
        </label>
      )}
      
      <div className="relative">
        {leftIcon && (
          <div className="absolute left-3 top-1/2 transform -translate-y-1/2 z-10">
            {leftIcon}
          </div>
        )}
        
        <select
          ref={ref}
          id={selectId}
          className={selectClasses}
          disabled={disabled}
          aria-describedby={`${hasError ? errorId : ''} ${hasHelper ? helperId : ''}`.trim()}
          aria-invalid={hasError ? 'true' : 'false'}
          onFocus={() => setIsOpen(true)}
          onBlur={() => setIsOpen(false)}
          onMouseDown={() => setIsOpen(true)}
          {...props}
        >
          {options.map(option => (
            <option 
              key={option.value} 
              value={option.value} 
              className="bg-black text-white"
            >
              {option.label}
            </option>
          ))}
        </select>
        
        {/* Dropdown arrow icon */}
        <div className="absolute right-3 top-1/2 transform -translate-y-1/2 z-10 pointer-events-none">
          <FontAwesomeIcon 
            icon={faChevronDown} 
            className={`w-4 h-4 text-neutral-400 transition-transform duration-200 ${
              isOpen ? 'rotate-180' : 'rotate-0'
            }`}
          />
        </div>
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

Select.displayName = 'Select';

export default Select; 