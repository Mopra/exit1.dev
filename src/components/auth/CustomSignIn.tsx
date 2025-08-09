import React from 'react';
import { LoginForm } from './LoginForm';

const CustomSignIn: React.FC = () => {
  return (
    <div className="bg-muted flex min-h-svh flex-col items-center justify-center gap-2 p-2 sm:gap-6 sm:p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-2 sm:gap-6">
        <a href="/" className="flex items-center gap-2 self-center font-medium">
          <img src="/e_.svg" alt="Exit1.dev Logo" className="size-6 shrink-0" />
          exit1.dev
        </a>
        <LoginForm />
      </div>
    </div>
  );
};

export default CustomSignIn; 