import React, { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { httpsCallable } from 'firebase/functions';
import { functions } from '@/firebase';
import { PageContainer } from '@/components/layout';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Alert,
  AlertDescription,
} from '@/components/ui';
import { CheckCircle, AlertTriangle, Mail, Loader2 } from 'lucide-react';

const OptOut: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState<string>('');

  useEffect(() => {
    const optOut = async () => {
      const email = searchParams.get('email');
      
      if (!email) {
        setStatus('error');
        setMessage('Invalid opt-out link. Email parameter is missing.');
        return;
      }

      try {
        const optOutByEmail = httpsCallable(functions, 'optOutByEmail');
        const result = await optOutByEmail({ email });
        
        if (result.data && typeof result.data === 'object' && 'success' in result.data) {
          const data = result.data as { success: boolean; message?: string };
          if (data.success) {
            setStatus('success');
            setMessage(data.message || 'You have been successfully opted out of product update emails.');
          } else {
            setStatus('error');
            setMessage('Failed to opt out. Please try again.');
          }
        } else {
          setStatus('error');
          setMessage('Invalid response from server.');
        }
      } catch (error: any) {
        setStatus('error');
        setMessage(error?.message || 'Failed to opt out. Please try again later.');
      }
    };

    optOut();
  }, [searchParams]);

  return (
    <PageContainer>
      <div className="flex items-center justify-center min-h-screen p-6">
        <Card className="w-full max-w-md bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40 border-sky-200/50">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              {status === 'loading' && (
                <Loader2 className="w-12 h-12 text-primary animate-spin" />
              )}
              {status === 'success' && (
                <CheckCircle className="w-12 h-12 text-green-500" />
              )}
              {status === 'error' && (
                <AlertTriangle className="w-12 h-12 text-destructive" />
              )}
            </div>
            <CardTitle className="text-2xl">
              {status === 'loading' && 'Processing...'}
              {status === 'success' && 'Opted Out'}
              {status === 'error' && 'Error'}
            </CardTitle>
            <CardDescription>
              {status === 'loading' && 'Please wait while we process your request.'}
              {status === 'success' && 'You have been opted out of product update emails.'}
              {status === 'error' && 'There was an error processing your request.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {message && (
              <Alert variant={status === 'success' ? 'default' : 'destructive'}>
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            )}
            
            {status === 'success' && (
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>You will no longer receive product update emails from Exit1.dev.</p>
                <p>If you change your mind, you can opt back in from your profile settings.</p>
              </div>
            )}

            <div className="flex gap-2 pt-4">
              {status !== 'loading' && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => navigate('/')}
                    className="flex-1 cursor-pointer"
                  >
                    Go to Home
                  </Button>
                  <Button
                    variant="default"
                    onClick={() => navigate('/profile')}
                    className="flex-1 cursor-pointer gap-2"
                  >
                    <Mail className="w-4 h-4" />
                    Manage Preferences
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
};

export default OptOut;

