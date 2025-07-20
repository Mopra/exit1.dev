import React from 'react';
import { colors } from '../../config/theme';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  variant?: 'default' | 'elevated' | 'outlined';
}

const Card: React.FC<CardProps> = React.memo(({
  children,
  variant = 'default',
  className = '',
  ...props
}) => {
  const baseClasses = `${colors.background.secondary} border ${colors.border.secondary} rounded-sm`;
  
  const variantClasses = {
    default: '',
    elevated: `shadow-lg shadow-${colors.text.primary}/10`,
    outlined: colors.border.secondary
  };

  const classes = `${baseClasses} ${variantClasses[variant]} ${className}`;

  return (
    <div className={classes} {...props}>
      {children}
    </div>
  );
});

Card.displayName = 'Card';

export default Card; 