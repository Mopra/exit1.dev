import React from 'react';

interface DividerProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical';
  variant?: 'default' | 'dashed';
}

const Divider: React.FC<DividerProps> = React.memo(({
  orientation = 'horizontal',
  variant = 'default',
  className = '',
  ...props
}) => {
  const baseClasses = 'border-white/30';
  
  const orientationClasses = {
    horizontal: 'w-full border-t',
    vertical: 'h-full border-l'
  };
  
  const variantClasses = {
    default: '',
    dashed: 'border-dashed'
  };

  const classes = `${baseClasses} ${orientationClasses[orientation]} ${variantClasses[variant]} ${className}`;

  return (
    <div className={classes} {...props} />
  );
});

Divider.displayName = 'Divider';

export default Divider; 