import React, { useState, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import CheckForm from '../components/check/CheckForm';
import CheckTable from '../components/check/CheckTable';
import LoadingSkeleton from '../components/layout/LoadingSkeleton';
import { useChecks } from '../hooks/useChecks';
import { httpsCallable } from "firebase/functions";
import { functions } from '../firebase';
import { Button, Input, ErrorModal } from '../components/ui';
import { useAuthReady } from '../AuthReadyProvider';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faSearch } from '@fortawesome/free-solid-svg-icons';
import { parseFirebaseError } from '../utils/errorHandler';
import type { ParsedError } from '../utils/errorHandler';

const Checks: React.FC = () => {
  const { userId } = useAuth();
  const authReady = useAuthReady();
  const [formLoading, setFormLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
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
    updateCheck, 
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

  const handleAdd = async (data: {
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
  }) => {
    if (!userId || !authReady) return;
    
    setFormLoading(true);
    try {
      const checkType = data.type === 'rest_endpoint' ? 'REST endpoint' : 'website';
      log(`Adding ${checkType}: ${data.name} (${data.url})`);
      
      // Use the Firebase function for both types to support advanced settings
      const addCheckFunction = httpsCallable(functions, "addCheck");
      await addCheckFunction({
        url: data.url,
        name: data.name,
        type: data.type,
        checkFrequency: data.checkFrequency || 60, // Default to 60 minutes (1 hour) - backend expects minutes
        httpMethod: data.httpMethod || (data.type === 'website' ? 'HEAD' : 'GET'),
        expectedStatusCodes: data.expectedStatusCodes || (data.type === 'website' ? [200, 201, 202, 204, 301, 302, 404] : [200, 201, 202]),
        requestHeaders: data.requestHeaders || {},
        requestBody: data.requestBody || '',
        responseValidation: data.responseValidation || {}
      });
      
      log(`${checkType} added successfully`);
      
      // Close form and refresh
      setShowForm(false);
      refresh();
    } catch (error: any) {
      const parsedError = parseFirebaseError(error);
      setErrorModal({
        isOpen: true,
        error: parsedError
      });
      console.error('Error adding check:', error);
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

  if (!authReady) {
    return <LoadingSkeleton />;
  }

  return (
    <div className="flex flex-1 flex-col h-full overflow-hidden min-w-0 w-full max-w-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 p-4 sm:p-6 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Checks</h1>
          <p className="text-sm text-muted-foreground hidden sm:block">
            Monitor your websites and API endpoints
          </p>
        </div>
        <Button onClick={() => setShowForm(true)} className="gap-2 shrink-0">
          <FontAwesomeIcon icon={faPlus} className="w-4 h-4" />
          <span className="hidden sm:inline">Add Check</span>
        </Button>
      </div>

      {/* Search */}
      <div className="flex items-center gap-4 p-4 sm:p-6 pb-0">
        <div className="relative flex-1 max-w-sm">
          <FontAwesomeIcon 
            icon={faSearch} 
            className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" 
          />
          <Input
            type="text"
            placeholder="Search checks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      {/* Checks Table */}
      <div className="flex-1 px-4 sm:px-6 pb-4 sm:pb-6 pt-4 min-h-0">
        <div className="h-full max-w-full overflow-hidden">
          <CheckTable
            checks={filteredChecks()}
            onUpdate={updateCheck}
            onDelete={deleteCheck}
            onBulkDelete={bulkDeleteChecks}
            onReorder={reorderChecks}
            onToggleStatus={toggleCheckStatus}
            onBulkToggleStatus={bulkToggleCheckStatus}
            onCheckNow={manualCheck}
            searchQuery={searchQuery}
            onAddFirstCheck={() => setShowForm(true)}
            optimisticUpdates={optimisticUpdates}
            manualChecksInProgress={manualChecksInProgress}
          />
        </div>
      </div>
      
      {/* Add Check Form Slide-out */}
      <CheckForm
        onSubmit={handleAdd}
        loading={formLoading}
        isOpen={showForm}
        onClose={() => setShowForm(false)}
      />
      
      {/* Error Modal */}
      <ErrorModal
        isOpen={errorModal.isOpen}
        onClose={closeErrorModal}
        title={errorModal.error.title}
        message={errorModal.error.message}
      />
    </div>
  );
};

export default Checks;