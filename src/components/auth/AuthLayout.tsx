import React from 'react';
import Card from '../ui/Card';
import { colors, typography } from '../../config/theme';

interface AuthLayoutProps {
  children: React.ReactNode;
  title: string;
  outerClassName?: string;
}

const AuthLayout: React.FC<AuthLayoutProps> = ({ children, title, outerClassName = '' }) => {
  return (
    <div className={`min-h-screen ${colors.text.primary} ${typography.fontFamily.body} flex items-start justify-center pt-20 ${outerClassName}`}>
      <Card className={`w-full max-w-md ${colors.border.secondary}`}>
        <div className="p-8">
          <h1 className={`text-3xl font-bold tracking-widest uppercase mb-2 ${colors.text.primary} ${typography.fontFamily.display} text-center`}>
            exit1.dev
          </h1>
          <p className={`text-sm ${colors.text.secondary} tracking-widest text-center mb-8`}>
            Website Monitoring Platform
          </p>
          <h2 className="text-xl font-medium mb-6 text-center">{title}</h2>
          {children}
        </div>
      </Card>
    </div>
  );
};

export default AuthLayout; 