import { useState, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import CheckForm from '../components/check/CheckForm';
import CheckTable from '../components/check/CheckTable';
import LoadingSkeleton from '../components/layout/LoadingSkeleton';
import { useChecks } from '../hooks/useChecks';
import { httpsCallable } from "firebase/functions";
import { functions } from '../firebase';
import { Card, Button, Input, Modal } from '../components/ui';
import { theme, typography } from '../config/theme';
import { useAuthReady } from '../AuthReadyProvider';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faSearch, faCheckCircle, faTimesCircle } from '@fortawesome/pro-regular-svg-icons';

export default function Checks() {
  const { userId } = useAuth();
  const authReady = useAuthReady();
  const [formLoading, setFormLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
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
    bulkToggleCheckStatus
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
        httpMethod: data.httpMethod || (data.type === 'website' ? 'HEAD' : 'GET'),
        expectedStatusCodes: data.expectedStatusCodes || (data.type === 'website' ? [200, 201, 202, 204, 301, 302, 404] : [200, 201, 202]),
        requestHeaders: data.requestHeaders || {},
        requestBody: data.requestBody || '',
        responseValidation: data.responseValidation || {}
      });
      
      log(`${checkType} added successfully.`);
      // Close modal after successful addition
      setShowForm(false);
    } catch (err: unknown) {
      const error = err as { message?: string };
      log('Error adding check: ' + (error.message || 'Unknown error'));
    } finally {
      setFormLoading(false);
    }
  };

  const handleUpdate = async (id: string, name: string, url: string) => {
    try {
      log(`Updating check: ${name} (${url})`);
      await updateCheck(id, name, url);
      log('Check updated successfully.');
    } catch (err: unknown) {
      const error = err as { message?: string };
      log('Error updating check: ' + (error.message || 'Unknown error'));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      log('Deleting check...');
      await deleteCheck(id);
      log('Check deleted successfully.');
    } catch (err: unknown) {
      const error = err as { message?: string };
      log('Error deleting check: ' + (error.message || 'Unknown error'));
    }
  };

  const handleCheckNow = async (id: string) => {
    try {
      log('Manually checking...');
      const manualCheck = httpsCallable(functions, "manualCheck");
      await manualCheck({ checkId: id });
      log('Check completed.');
    } catch (err: unknown) {
      const error = err as { message?: string; code?: string };
      log('Error checking: ' + (error.message || error.code || 'Unknown error'));
    }
  };

  const handleReorder = async (fromIndex: number, toIndex: number) => {
    try {
      log(`Reordering check from position ${fromIndex + 1} to ${toIndex + 1}`);
      await reorderChecks(fromIndex, toIndex);
      log('Check order updated successfully.');
    } catch (err: unknown) {
      const error = err as { message?: string };
      log('Error reordering checks: ' + (error.message || 'Unknown error'));
    }
  };

  const handleToggleStatus = async (id: string, disabled: boolean) => {
    if (!userId || !authReady) return;
    
    try {
      log(`Toggling check status: ${disabled ? 'disable' : 'enable'}`);
      await toggleCheckStatus(id, disabled);
      log('Check status updated successfully.');
    } catch (err: unknown) {
      const error = err as { message?: string };
      log('Error toggling check status: ' + (error.message || 'Unknown error'));
    }
  };

  const handleBulkDelete = async (ids: string[]) => {
    if (!userId || !authReady) return;
    
    try {
      log(`Bulk deleting ${ids.length} checks...`);
      await bulkDeleteChecks(ids);
      log(`${ids.length} checks deleted successfully.`);
    } catch (err: unknown) {
      const error = err as { message?: string };
      log('Error bulk deleting checks: ' + (error.message || 'Unknown error'));
    }
  };

  const handleBulkToggleStatus = async (ids: string[], disabled: boolean) => {
    if (!userId || !authReady) return;
    
    try {
      log(`Bulk ${disabled ? 'disabling' : 'enabling'} ${ids.length} checks...`);
      await bulkToggleCheckStatus(ids, disabled);
      log(`${ids.length} checks ${disabled ? 'disabled' : 'enabled'} successfully.`);
    } catch (err: unknown) {
      const error = err as { message?: string };
      log('Error bulk toggling check status: ' + (error.message || 'Unknown error'));
    }
  };





  return (
    <>
      {/* Checks Section */}
      <Card className="py-4 sm:py-6 mb-8 sm:mb-12 border-0">
        {/* Main Header */}
        <div className="mb-4 sm:mb-6">
          <div className="flex flex-col gap-3 sm:gap-4">
            {/* Title and Primary Actions */}
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 sm:gap-4">
              <h1 className={`text-xl sm:text-2xl uppercase tracking-widest ${typography.fontFamily.display} ${theme.colors.text.primary}`}>
                Monitored Checks
              </h1>
              <div className="flex gap-2">
                <Button
                  onClick={() => setShowForm(true)}
                  variant="gradient"
                  size="md"
                  className="flex items-center gap-2 w-full sm:w-auto justify-center"
                >
                  <FontAwesomeIcon icon={faPlus} className="w-3 h-3" />
                  Add Check
                </Button>
              </div>
            </div>

            {/* Search and Quick Stats */}
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 sm:gap-4">
              {/* Unified Stats Display */}
              <div className="flex items-center gap-3 sm:gap-4 text-sm">
                <div className="flex items-center gap-2 sm:gap-3">
                  <span className="flex items-center gap-1">
                    <FontAwesomeIcon icon={faCheckCircle} className="text-green-500" />
                    <span className={theme.colors.text.muted}>
                      {checks.filter(c => c.status === 'online' || c.status === 'UP' || c.status === 'REDIRECT').length} online
                    </span>
                  </span>
                  <span className="flex items-center gap-1">
                    <FontAwesomeIcon icon={faTimesCircle} className="text-red-500" />
                    <span className={theme.colors.text.muted}>
                      {checks.filter(c => c.status === 'offline' || c.status === 'DOWN' || c.status === 'REACHABLE_WITH_ERROR').length} offline
                    </span>
                  </span>
                  <span className={`${typography.fontFamily.mono} ${theme.colors.text.muted} hidden sm:inline`}>
                    {checks.length} checks
                  </span>
                </div>
              </div>

              {/* Search Bar */}
              <div className="relative w-full sm:w-80">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <FontAwesomeIcon icon={faSearch} className={`w-4 h-4 ${theme.colors.text.muted}`} />
                </div>
                <Input
                  type="text"
                  placeholder="Search checks..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center cursor-pointer"
                  >
                    <span className={`text-sm ${theme.colors.text.muted} hover:${theme.colors.text.primary} transition-colors`}>
                      ✕
                    </span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        
        {loading || !authReady ? (
          <div className="px-3 sm:px-4 mt-4 sm:mt-6" role="status" aria-label="Loading checks">
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
          />
        )}
      </Card>



      {/* Add Check Modal */}
      <Modal
        isOpen={showForm}
        onClose={() => setShowForm(false)}
        title="Add New Check"
        size="xl"
      >
        <CheckForm
          onSubmit={handleAdd}
          loading={formLoading}
          noCard={true}
        />
      </Modal>
    </>
  );
} 