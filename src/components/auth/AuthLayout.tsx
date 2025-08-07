import React from 'react';

interface AuthLayoutProps {
  children: React.ReactNode;
  outerClassName?: string;
}

const AuthLayout: React.FC<AuthLayoutProps> = ({ children, outerClassName = '' }) => {
  return (
    <div className={`min-h-screen text-white flex items-start justify-center pt-20 ${outerClassName}`}>
      <div className="w-full max-w-md px-4">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-widest uppercase mb-2 text-white text-center">
            EXIT1.DEV
          </h1>
          <p className="text-muted-foreground text-sm">
            Monitoring made simple
          </p>
        </div>
        {children}
      </div>
    </div>
  );
};

export default AuthLayout; 