import React from 'react';
import { theme, typography } from '../../config/theme';

interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  children: React.ReactNode;
  required?: boolean;
}

const Label: React.FC<LabelProps> = React.memo(({
  children,
  required = false,
  className = '',
  ...props
}) => {
  return (
    <label className={`block text-sm ${typography.fontFamily.mono} ${theme.colors.text.primary} uppercase tracking-widest ${className}`} {...props}>
      {children}
      {required && <span className={`${theme.colors.status.offline} ml-1`}>*</span>}
    </label>
  );
});

Label.displayName = 'Label';

export default Label; 