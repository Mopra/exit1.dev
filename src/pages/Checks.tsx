import React, { useState, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import CheckForm from '../components/check/CheckForm';
import CheckTable from '../components/check/CheckTable';
import LoadingSkeleton from '../components/layout/LoadingSkeleton';
import { useChecks } from '../hooks/useChecks';
import { useWebsiteUrl } from '../hooks/useWebsiteUrl';
import { httpsCallable } from "firebase/functions";
import { functions } from '../firebase';
import { Button, ErrorModal, SearchInput } from '../components/ui';
import { PageHeader, PageContainer } from '../components/layout';
import { Plus, Globe } from 'lucide-react';
import { useAuthReady } from '../AuthReadyProvider';
import { parseFirebaseError } from '../utils/errorHandler';
import type { ParsedError } from '../utils/errorHandler';
import { toast } from 'sonner';
import type { Website } from '../types';

const Checks: React.FC = () => {
  const { userId } = useAuth();
  const authReady = useAuthReady();
  const { websiteUrl, isValidUrl, hasProcessed, clearWebsiteUrl } = useWebsiteUrl();
  console.log('Checks component - websiteUrl:', websiteUrl, 'isValidUrl:', isValidUrl, 'hasProcessed:', hasProcessed);
  const [formLoading, setFormLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingCheck, setEditingCheck] = useState<Website | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const hasAutoCreatedRef = React.useRef(false);
  const [errorModal, setErrorModal] = useState<{
    isOpen: boolean;
    error: ParsedError;
  }>({
    isOpen: false,
    error: { title: '', message: '' }
  });
  
  const log = useCallback(
    (msg: string) => console.log(`[Checks] ${msg}`),
    []
  );

  // Use enhanced hook with direct Firestore operations
  const { 
    checks, 
    deleteCheck, 
    bulkDeleteChecks,
    reorderChecks,
    toggleCheckStatus,
    bulkToggleCheckStatus,
    manualCheck,
    refresh,
    optimisticUpdates,
    manualChecksInProgress
  } = useChecks(userId ?? null, log);

  // Filter checks based on search query
  const filteredChecks = useCallback(() => {
    if (!searchQuery.trim()) return checks;
    
    const query = searchQuery.toLowerCase();
    return checks.filter(check => 
      check.name.toLowerCase().includes(query) ||
      check.url.toLowerCase().includes(query) ||
      (check.type || 'website').toLowerCase().includes(query) ||
      (check.status || '').toLowerCase().includes(query)
    );
  }, [checks, searchQuery]);

  const handleUpsert = async (data: {
    id?: string;
    name: string;
    url: string;
    type: 'website' | 'rest_endpoint';
    checkFrequency?: number;
    httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
    expectedStatusCodes?: number[];
    requestHeaders?: { [key: string]: string };
    requestBody?: string;
    responseValidation?: {
      containsText?: string[];
      jsonPath?: string;
      expectedValue?: unknown;
    };
    immediateRecheckEnabled?: boolean;
  }) => {
    console.log('handleUpsert called with data:', data);
    console.log('userId:', userId, 'authReady:', authReady);
    
    if (!userId || !authReady) {
      console.error('Cannot add check: userId or authReady is missing');
      throw new Error('Authentication required');
    }
    
    setFormLoading(true);
    try {
      const isEdit = !!data.id;
      const checkType = data.type === 'rest_endpoint' ? 'REST endpoint' : 'website';
      log(`${isEdit ? 'Updating' : 'Adding'} ${checkType}: ${data.name} (${data.url})`);
      
      const checkData = {
        ...(data.id ? { id: data.id } : {}),
        url: data.url,
        name: data.name,
        type: data.type,
        checkFrequency: data.checkFrequency || 60, // Default to 60 minutes (1 hour) - backend expects minutes
        httpMethod: data.httpMethod || (data.type === 'website' ? 'HEAD' : 'GET'),
        expectedStatusCodes: data.expectedStatusCodes || (data.type === 'website' ? [200, 201, 202, 204, 301, 302, 404] : [200, 201, 202]),
        requestHeaders: data.requestHeaders || {},
        requestBody: data.requestBody || '',
        responseValidation: data.responseValidation || {},
        immediateRecheckEnabled: data.immediateRecheckEnabled !== false // Default to true
      };
      
      console.log('Calling Firebase function with data:', checkData);
      
      const callableName = data.id ? "updateCheck" : "addCheck";
      const fn = httpsCallable(functions, callableName);
      const result = await fn(checkData);
      
      console.log('Firebase function result:', result);
      
      log(`${checkType} ${data.id ? 'updated' : 'added'} successfully`);
      
      // Show success toast
      toast.success(`${checkType} ${data.id ? 'updated' : 'added'} successfully!`, {
        description: data.id ? `${data.name} settings saved.` : `${data.name} is now being monitored.`,
        duration: 4000,
      });
      
      // Refresh (realtime subscription will also update UI)
      refresh();
    } catch (error: any) {
      console.error('Error saving check:', error);
      const parsedError = parseFirebaseError(error);
      setErrorModal({
        isOpen: true,
        error: parsedError
      });
      throw error;
    } finally {
      setFormLoading(false);
    }
  };

  const closeErrorModal = () => {
    setErrorModal({
      isOpen: false,
      error: { title: '', message: '' }
    });
  };



  // Auto-create check if website URL is provided from marketing site
  React.useEffect(() => {
    console.log('Auto-create effect running:', {
      websiteUrl,
      isValidUrl,
      hasProcessed,
      authReady,
      hasAutoCreated: hasAutoCreatedRef.current
    });
    
    if (websiteUrl && isValidUrl && hasProcessed && authReady && !hasAutoCreatedRef.current) {
      console.log('Auto-creating check for website URL:', websiteUrl);
      const currentWebsiteUrl = websiteUrl; // Store the URL before clearing
      hasAutoCreatedRef.current = true;
      
      // Auto-create the check
      const checkData = {
        name: generateFriendlyName(currentWebsiteUrl),
        url: currentWebsiteUrl.startsWith('http') ? currentWebsiteUrl : `https://${currentWebsiteUrl}`,
        type: 'website' as const,
        checkFrequency: 60, // 1 hour
        httpMethod: 'HEAD' as const,
        expectedStatusCodes: [200, 201, 202, 204, 301, 302, 404],
        requestHeaders: {},
        requestBody: '',
        responseValidation: {}
      };
      
      // Call handleAdd directly
      void handleUpsert(checkData);
      
      // Clear the website URL
      clearWebsiteUrl();
      
      // Note: handleAdd will show its own success toast, so we don't need this one
    }
  }, [websiteUrl, isValidUrl, hasProcessed, authReady, clearWebsiteUrl]);

  // Helper function to generate a friendly name from URL
  const generateFriendlyName = (url: string): string => {
    try {
      const fullUrl = url.startsWith('http') ? url : `https://${url}`;
      const urlObj = new URL(fullUrl);
      const hostname = urlObj.hostname;
      
      if (hostname && hostname.length > 0) {
        let friendlyName = hostname
          .replace(/^www\./, '')
          .split('.')
          .slice(0, -1)
          .join('.')
          .replace(/[-_.]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .split(' ')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join(' ');
        
        if (!friendlyName || friendlyName.length < 2) {
          const domainWithoutExtension = hostname
            .replace(/^www\./, '')
            .split('.')
            .slice(0, -1)
            .join('.');
          friendlyName = domainWithoutExtension || hostname.replace(/^www\./, '');
        }
        
        return friendlyName;
      }
    } catch (error) {
      console.error('Error generating name from URL:', error);
    }
    
    // Fallback
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '');
  };

  if (!authReady) {
    return <LoadingSkeleton />;
  }

  return (
    <PageContainer>
      <PageHeader 
        title="Checks" 
        description="Monitor your websites and API endpoints"
        icon={Globe}
        actions={
          <Button
            onClick={() => {
              setEditingCheck(null);
              setShowForm(true);
            }}
            className="gap-2"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Add Check</span>
          </Button>
        }
      />

      <SearchInput 
        value={searchQuery} 
        onChange={setSearchQuery} 
        placeholder="Search checks..." 
      />

      {/* Checks Table */}
      <div className="flex-1 p-6 min-h-0">
        <div className="h-full max-w-full overflow-hidden">
          <CheckTable
            checks={filteredChecks()}
            onDelete={deleteCheck}
            onBulkDelete={bulkDeleteChecks}
            onReorder={reorderChecks}
            onToggleStatus={toggleCheckStatus}
            onBulkToggleStatus={bulkToggleCheckStatus}
            onCheckNow={manualCheck}
            onEdit={(check) => {
              setEditingCheck(check);
              setShowForm(true);
            }}
            searchQuery={searchQuery}
            onAddFirstCheck={() => {
              setEditingCheck(null);
              setShowForm(true);
            }}
            optimisticUpdates={optimisticUpdates}
            manualChecksInProgress={manualChecksInProgress}
          />
        </div>
      </div>
      
      {/* Add Check Form Slide-out */}
      <CheckForm
        mode={editingCheck ? 'edit' : 'create'}
        initialCheck={editingCheck}
        onSubmit={handleUpsert}
        loading={formLoading}
        isOpen={showForm}
        onClose={() => {
          setShowForm(false);
          setEditingCheck(null);
        }}
        prefillWebsiteUrl={websiteUrl}
      />
      
      {/* Error Modal */}
      <ErrorModal
        isOpen={errorModal.isOpen}
        onClose={closeErrorModal}
        title={errorModal.error.title}
        message={errorModal.error.message}
      />
    </PageContainer>
  );
};

export default Checks;