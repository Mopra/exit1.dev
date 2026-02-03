import React, { useState } from 'react';
import { useSignIn } from '@clerk/clerk-react';
import { useNavigate, Link } from 'react-router-dom';
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from '../ui';

export function ForgotPasswordForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const navigate = useNavigate();
  const { isLoaded, signIn } = useSignIn();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'email' | 'code' | 'newPassword'>('email');
  const [success, setSuccess] = useState(false);

  const validateEmail = (value: string): string | undefined => {
    if (!value) return 'Email is required';
    if (!/^[\w-.]+@([\w-]+\.)+[\w-]{2,}$/.test(value)) return 'Invalid email format';
    return undefined;
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!signIn || !isLoaded) {
      setError('Authentication service is not ready. Please try again.');
      return;
    }

    const emailError = validateEmail(email);
    if (emailError) {
      setError(emailError);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await signIn.create({
        strategy: 'reset_password_email_code',
        identifier: email,
      });
      setStep('code');
    } catch (err: any) {
      setError(err.errors?.[0]?.message || 'Failed to send reset code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!code) {
      setError('Verification code is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await signIn?.attemptFirstFactor({
        strategy: 'reset_password_email_code',
        code,
      });

      if (result?.status === 'needs_new_password') {
        setStep('newPassword');
      } else {
        setError('Verification failed. Please try again.');
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.message || 'Invalid verification code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!password) {
      setError('Password is required');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters long');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await signIn?.resetPassword({
        password,
      });

      if (result?.status === 'complete') {
        setSuccess(true);
        // Navigate to sign in after a short delay
        setTimeout(() => {
          navigate('/sign-in', { 
            state: { message: 'Password reset successfully. Please sign in with your new password.' }
          });
        }, 2000);
      } else {
        setError('Password reset failed. Please try again.');
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.message || 'Failed to reset password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const renderEmailStep = () => (
    <form onSubmit={handleEmailSubmit}>
      <div className="grid gap-6">
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="m@example.com"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </div>
        
        {error && <p className="text-destructive text-sm">{error}</p>}
        
        <Button type="submit" className="w-full" disabled={loading || !isLoaded}>
          {loading ? (
            <div className="flex items-center justify-center w-full">
              <Spinner size="sm" className="mr-2" />
              <span>Sending Reset Code...</span>
            </div>
          ) : (
            'Send Reset Code'
          )}
        </Button>
        
        <div className="text-center text-sm">
          Remember your password?{" "}
          <Link to="/sign-in" className="underline underline-offset-4">
            Sign in
          </Link>
        </div>
      </div>
    </form>
  );

  const renderCodeStep = () => (
    <form onSubmit={handleCodeSubmit}>
      <div className="grid gap-6">
        <div className="text-sm text-muted-foreground">
          We've sent a verification code to <strong>{email}</strong>. 
          Please check your email and enter the code below.
        </div>
        
        <div className="grid gap-2">
          <Label htmlFor="code">Verification Code</Label>
          <Input
            id="code"
            type="text"
            placeholder="Enter code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
        </div>
        
        {error && <p className="text-destructive text-sm">{error}</p>}
        
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? (
            <div className="flex items-center justify-center w-full">
              <Spinner size="sm" className="mr-2" />
              <span>Verifying...</span>
            </div>
          ) : (
            'Verify Code'
          )}
        </Button>
        
        <div className="text-center text-sm">
          <button
            type="button"
            onClick={() => setStep('email')}
            className="underline underline-offset-4 hover:text-foreground"
          >
            Back to email
          </button>
        </div>
      </div>
    </form>
  );

  const renderPasswordStep = () => (
    <form onSubmit={handlePasswordSubmit}>
      <div className="grid gap-6">
        <div className="grid gap-2">
          <Label htmlFor="password">New Password</Label>
          <Input
            id="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </div>
        
        <div className="grid gap-2">
          <Label htmlFor="confirmPassword">Confirm Password</Label>
          <Input
            id="confirmPassword"
            type="password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </div>
        
        {error && <p className="text-destructive text-sm">{error}</p>}
        
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? (
            <div className="flex items-center justify-center w-full">
              <Spinner size="sm" className="mr-2" />
              <span>Resetting Password...</span>
            </div>
          ) : (
            'Reset Password'
          )}
        </Button>
      </div>
    </form>
  );

  const renderSuccessStep = () => (
    <div className="grid gap-6 text-center">
      <div className="text-green-600 text-sm">
        ✓ Password reset successfully! Redirecting to sign in...
      </div>
    </div>
  );

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle>
            {step === 'email' && 'Reset your password'}
            {step === 'code' && 'Enter verification code'}
            {step === 'newPassword' && 'Set new password'}
            {success && 'Password reset complete'}
          </CardTitle>
          <CardDescription>
            {step === 'email' && 'Enter your email address and we\'ll send you a reset code'}
            {step === 'code' && 'Check your email for the verification code'}
            {step === 'newPassword' && 'Choose a new password for your account'}
            {success && 'You can now sign in with your new password'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {success ? renderSuccessStep() : (
            <>
              {step === 'email' && renderEmailStep()}
              {step === 'code' && renderCodeStep()}
              {step === 'newPassword' && renderPasswordStep()}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
