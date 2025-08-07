import { useState, useCallback } from 'react';
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
import { faPlus, faSearch, faCheckCircle, faTimesCircle } from '@fortawesome/free-solid-svg-icons';
import { parseFirebaseError } from '../utils/errorHandler';
import type { ParsedError } from '../utils/errorHandler';

export default function Checks() {
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
    loading, 
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
    checkFrequency?: number; // Add this field
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
        checkFrequency: data.checkFrequency || 10, // Add this field
        httpMethod: data.httpMethod || (data.type === 'website' ? 'HEAD' : 'GET'),
        expectedStatusCodes: data.expectedStatusCodes || (data.type === 'website' ? [200, 201, 202, 204, 301, 302, 404] : [200, 201, 202]),
        requestHeaders: data.requestHeaders || {},
        requestBody: data.requestBody || '',
        responseValidation: data.responseValidation || {}
      });
      
      log(`${checkType} added successfully.`);
      // Refresh the checks list to show the new check immediately
      refresh();
      // Close modal after successful addition
      setShowForm(false);
          } catch (err: unknown) {
        const parsedError = parseFirebaseError(err);
        setErrorModal({
          isOpen: true,
          error: parsedError
        });
        log('Error adding check: ' + parsedError.message);
      } finally {
      setFormLoading(false);
    }
  };

  const handleUpdate = async (id: string, name: string, url: string, checkFrequency?: number) => {
    try {
      log(`Updating check: ${name} (${url})`);
      await updateCheck(id, name, url, checkFrequency);
      log('Check updated successfully.');
    } catch (err: unknown) {
      const parsedError = parseFirebaseError(err);
      setErrorModal({
        isOpen: true,
        error: parsedError
      });
      log('Error updating check: ' + parsedError.message);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      log('Deleting check...');
      await deleteCheck(id);
      log('Check deleted successfully.');
    } catch (err: unknown) {
      const parsedError = parseFirebaseError(err);
      setErrorModal({
        isOpen: true,
        error: parsedError
      });
      log('Error deleting check: ' + parsedError.message);
    }
  };

  const handleCheckNow = async (id: string) => {
    try {
      log('Manually checking...');
      await manualCheck(id);
      log('Check completed.');
    } catch (err: unknown) {
      const parsedError = parseFirebaseError(err);
      setErrorModal({
        isOpen: true,
        error: parsedError
      });
      log('Error checking: ' + parsedError.message);
    }
  };

  const handleReorder = async (fromIndex: number, toIndex: number) => {
    try {
      log(`Reordering check from position ${fromIndex + 1} to ${toIndex + 1}`);
      await reorderChecks(fromIndex, toIndex);
      log('Check order updated successfully.');
    } catch (err: unknown) {
      const parsedError = parseFirebaseError(err);
      setErrorModal({
        isOpen: true,
        error: parsedError
      });
      log('Error reordering checks: ' + parsedError.message);
    }
  };

  const handleToggleStatus = async (id: string, disabled: boolean) => {
    if (!userId || !authReady) return;
    
    try {
      log(`Toggling check status: ${disabled ? 'disable' : 'enable'}`);
      await toggleCheckStatus(id, disabled);
      log('Check status updated successfully.');
    } catch (err: unknown) {
      const parsedError = parseFirebaseError(err);
      setErrorModal({
        isOpen: true,
        error: parsedError
      });
      log('Error toggling check status: ' + parsedError.message);
    }
  };

  const handleBulkDelete = async (ids: string[]) => {
    if (!userId || !authReady) return;
    
    try {
      log(`Bulk deleting ${ids.length} checks...`);
      await bulkDeleteChecks(ids);
      log(`${ids.length} checks deleted successfully.`);
    } catch (err: unknown) {
      const parsedError = parseFirebaseError(err);
      setErrorModal({
        isOpen: true,
        error: parsedError
      });
      log('Error bulk deleting checks: ' + parsedError.message);
    }
  };

  const handleBulkToggleStatus = async (ids: string[], disabled: boolean) => {
    if (!userId || !authReady) return;
    
    try {
      log(`Bulk ${disabled ? 'disabling' : 'enabling'} ${ids.length} checks...`);
      await bulkToggleCheckStatus(ids, disabled);
      log(`${ids.length} checks ${disabled ? 'disabled' : 'enabled'} successfully.`);
    } catch (err: unknown) {
      const parsedError = parseFirebaseError(err);
      setErrorModal({
        isOpen: true,
        error: parsedError
      });
      log('Error bulk toggling check status: ' + parsedError.message);
    }
  };





  return (
    <>
      {/* Fixed Page Header - Never overflows */}
      <div className="w-full overflow-hidden mb-6">
        {/* Title and Primary Actions */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 sm:gap-4 w-full overflow-hidden">
          <h1 className="text-xl sm:text-2xl uppercase tracking-widest font-mono text-foreground flex-shrink-0">
            Monitored Checks
          </h1>
          <div className="flex gap-2 flex-shrink-0 w-full sm:max-w-[200px] justify-self-start sm:justify-self-end">
                          <Button
                onClick={() => setShowForm(true)}
                variant="default"
                size="default"
                className="flex items-center gap-2 w-full justify-center"
              >
              <FontAwesomeIcon icon={faPlus} className="w-3 h-3" />
              Add Check
            </Button>
          </div>
        </div>

        {/* Search and Quick Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 sm:gap-4 w-full mt-4 overflow-hidden">
          {/* Search Bar */}
          <div className="relative w-full sm:w-80 flex-shrink-0 min-w-0 overflow-hidden sm:max-w-[320px] justify-self-start">
            <div className="relative">
              <FontAwesomeIcon icon={faSearch} className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-neutral-300 pointer-events-none" />
              <Input
                type="text"
                placeholder="Search checks..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 pr-10"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 cursor-pointer"
                >
                  <span className="text-sm text-neutral-400 hover:text-neutral-200 transition-colors">
                    ✕
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Unified Stats Display */}
        <div className="flex items-center gap-3 sm:gap-4 text-sm flex-shrink-0 min-w-0 overflow-hidden mt-8">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 overflow-hidden">
            <span className="flex items-center gap-1 flex-shrink-0">
              <FontAwesomeIcon icon={faCheckCircle} className="text-green-500" />
              <span className="text-muted-foreground truncate">
                {checks.filter(c => c.status === 'online' || c.status === 'UP' || c.status === 'REDIRECT').length} online
              </span>
            </span>
            <span className="flex items-center gap-1 flex-shrink-0">
              <FontAwesomeIcon icon={faTimesCircle} className="text-red-500" />
              <span className="text-muted-foreground truncate">
                {checks.filter(c => c.status === 'offline' || c.status === 'DOWN' || c.status === 'REACHABLE_WITH_ERROR').length} offline
              </span>
            </span>
            <span className="font-mono text-muted-foreground hidden sm:inline flex-shrink-0 truncate">
              {checks.length} checks
            </span>
          </div>
        </div>
      </div>

      {/* Table Section - Can overflow independently */}
      <div className="w-full mt-6">
        {loading || !authReady ? (
          <div className="space-y-3" role="status" aria-label="Loading checks">
            <LoadingSkeleton type="list-item" />
            <LoadingSkeleton type="list-item" />
            <LoadingSkeleton type="list-item" />
          </div>
        ) : (
          <CheckTable
            checks={filteredChecks()}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onBulkDelete={handleBulkDelete}
            onCheckNow={handleCheckNow}
            onToggleStatus={handleToggleStatus}
            onBulkToggleStatus={handleBulkToggleStatus}
            onReorder={handleReorder}
            searchQuery={searchQuery}
            onAddFirstCheck={() => setShowForm(true)}
            optimisticUpdates={optimisticUpdates}
            manualChecksInProgress={manualChecksInProgress}
          />
        )}
      </div>

      {/* Add Check Button - Always centered below table */}
      <div className="w-full flex justify-center mt-8">
                  <Button
            onClick={() => setShowForm(true)}
            variant="default"
            size="default"
            className="flex items-center gap-2 cursor-pointer"
          >
          <FontAwesomeIcon icon={faPlus} className="w-3 h-3" />
          Add Check
        </Button>
      </div>



      {/* Add Check Slide-out Panel */}
      <CheckForm
        onSubmit={handleAdd}
        loading={formLoading}
        isOpen={showForm}
        onClose={() => setShowForm(false)}
      />

      {/* Error Modal */}
      <ErrorModal
        isOpen={errorModal.isOpen}
        onClose={() => setErrorModal(prev => ({ ...prev, isOpen: false }))}
        title={errorModal.error.title}
        message={errorModal.error.message}
      />
    </>
  );
} 