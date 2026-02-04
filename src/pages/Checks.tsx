import React, { useState, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import CheckForm from '../components/check/CheckForm';
import CheckTable from '../components/check/CheckTable';
import LoadingSkeleton from '../components/layout/LoadingSkeleton';
import { useChecks } from '../hooks/useChecks';
import { useWebsiteUrl } from '../hooks/useWebsiteUrl';
import { httpsCallable } from "firebase/functions";
import { functions } from '../firebase';
import { Button, ErrorModal, FeatureGate, SearchInput, Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui';
import { PageHeader, PageContainer } from '../components/layout';
import { LayoutGrid, List, Plus, Globe, Map, RefreshCw, Activity, Upload } from 'lucide-react';
import { useAuthReady } from '../AuthReadyProvider';
import { parseFirebaseError } from '../utils/errorHandler';
import type { ParsedError } from '../utils/errorHandler';
import { toast } from 'sonner';
import type { Website } from '../types';
import { useNanoPlan } from "@/hooks/useNanoPlan";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useUserPreferences } from "../hooks/useUserPreferences";
import CheckFolderView from "../components/check/CheckFolderView";
import CheckMapView from "../components/check/CheckMapView";
import CheckTimelineView from "../components/check/CheckTimelineView";
import { apiClient } from '../api/client';
import { getDefaultExpectedStatusCodes, getDefaultHttpMethod } from '../lib/check-defaults';
import BulkImportModal from '../components/check/BulkImportModal';

const Checks: React.FC = () => {
  const { userId } = useAuth();
  const authReady = useAuthReady();
  const { websiteUrl, isValidUrl, hasProcessed, clearWebsiteUrl } = useWebsiteUrl();
  const [formLoading, setFormLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingCheck, setEditingCheck] = useState<Website | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const hasAutoCreatedRef = React.useRef(false);
  const { nano } = useNanoPlan();
  const { preferences, loading: preferencesLoading, updateSorting } = useUserPreferences(userId);
  // Local state for immediate UI updates - Firestore is only for persistence
  // Initialize to null so we know when to sync from Firestore vs when user has made a choice
  const [checksSortBy, setChecksSortBy] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useLocalStorage<'none' | 'folder'>('checks-group-by-v1', 'none');
  const effectiveGroupBy = groupBy;
  const [checksView, setChecksView] = useLocalStorage<'table' | 'folders' | 'map' | 'timeline'>('checks-view-v1', 'table');
  const timelineEnabled = false;
  const [errorModal, setErrorModal] = useState<{
    isOpen: boolean;
    error: ParsedError;
  }>({
    isOpen: false,
    error: { title: '', message: '' }
  });
  const [updatingRegions, setUpdatingRegions] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);

  const log = useCallback(
    (_msg: string) => { },
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
    bulkUpdateSettings,
    manualCheck,
    setCheckFolder: _setCheckFolder, // Available for non-debounced use cases
    debouncedSetCheckFolder,
    flushPendingFolderUpdates,
    renameFolder,
    deleteFolder,
    refresh,
    optimisticUpdates,
    folderUpdates,
    manualChecksInProgress
  } = useChecks(userId ?? null, log);

  const hasFolders = React.useMemo(() => (
    checks.some((check) => (check.folder ?? '').trim().length > 0)
  ), [checks]);

  // Wrapper for debounced folder updates that matches the expected signature
  // (the debounced version returns a cleanup function, but components expect void)
  const handleSetFolderDebounced = React.useCallback((id: string, folder: string | null) => {
    debouncedSetCheckFolder(id, folder);
  }, [debouncedSetCheckFolder]);

  // Flush pending folder updates when component unmounts
  React.useEffect(() => {
    return () => {
      flushPendingFolderUpdates();
    };
  }, [flushPendingFolderUpdates]);

  // Default: group by folder if the user already has folders
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const existing = window.localStorage.getItem('checks-group-by-v1');
      if (existing === null) {
        if (hasFolders) {
          setGroupBy('folder');
        }
      }
    } catch {
      // ignore localStorage failures
    }
  }, [hasFolders, setGroupBy]);

  React.useEffect(() => {
    if (!timelineEnabled && checksView === 'timeline') {
      setChecksView('table');
    }
  }, [checksView, setChecksView, timelineEnabled]);

  // Sync sort from Firestore when local state hasn't been set yet
  React.useEffect(() => {
    // Only sync from Firestore if local state is null (not yet initialized)
    // and preferences have loaded
    if (checksSortBy === null && !preferencesLoading) {
      const savedSort = preferences?.sorting?.checks || 'custom';
      setChecksSortBy(savedSort);
    }
  }, [checksSortBy, preferences?.sorting, preferences?.sorting?.checks, preferencesLoading]);

  // Effective sort value (use 'custom' as fallback while loading)
  const effectiveSortBy = checksSortBy ?? 'custom';

  // Handle sort change - update local state immediately, persist to Firestore in background
  const handleSortChange = useCallback((sortOption: string) => {
    setChecksSortBy(sortOption);
    // Persist to Firestore for cross-session/device sync
    updateSorting('checks', sortOption)
      .then(() => console.log('[Checks] sort preference saved'))
      .catch((err) => {
        console.error('[Checks] Failed to persist sort preference:', err);
        toast.error('Failed to save sort preference');
      });
  }, [updateSorting]);

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
    type: 'website' | 'rest_endpoint' | 'tcp' | 'udp';
    checkFrequency?: number;
    responseTimeLimit?: number | null;
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
    downConfirmationAttempts?: number;
    cacheControlNoCache?: boolean;
    checkRegionOverride?: 'us-central1' | 'us-east4' | 'us-west1' | 'europe-west1' | 'asia-southeast1' | null;
  }) => {
    if (!userId || !authReady) {
      console.error('Cannot add check: userId or authReady is missing');
      throw new Error('Authentication required');
    }

    setFormLoading(true);
    try {
      const isEdit = !!data.id;
      const checkType =
        data.type === 'rest_endpoint'
          ? 'REST endpoint'
          : data.type === 'tcp'
            ? 'TCP check'
            : data.type === 'udp'
              ? 'UDP check'
              : 'website';
      log(`${isEdit ? 'Updating' : 'Adding'} ${checkType}: ${data.name} (${data.url})`);

      const immediateRecheckEnabled =
        data.immediateRecheckEnabled === undefined ? undefined : data.immediateRecheckEnabled === true;
      const isHttpCheck = data.type === 'website' || data.type === 'rest_endpoint';
      const checkData = {
        ...(data.id ? { id: data.id } : {}),
        url: data.url,
        name: data.name,
        type: data.type,
        checkFrequency: data.checkFrequency || 60, // Default to 60 minutes (1 hour) - backend expects minutes
        ...(isHttpCheck
          ? {
            httpMethod: data.httpMethod || getDefaultHttpMethod(data.type),
            expectedStatusCodes: data.expectedStatusCodes || getDefaultExpectedStatusCodes(data.type),
            requestHeaders: data.requestHeaders || {},
            requestBody: data.requestBody || '',
            responseValidation: data.responseValidation || {},
            cacheControlNoCache: data.cacheControlNoCache === true,
          }
          : {}),
        ...(immediateRecheckEnabled !== undefined ? { immediateRecheckEnabled } : {}),
        ...(data.downConfirmationAttempts !== undefined ? { downConfirmationAttempts: data.downConfirmationAttempts } : {}),
        ...(data.responseTimeLimit !== undefined ? { responseTimeLimit: data.responseTimeLimit } : {}),
        ...(data.checkRegionOverride !== undefined ? { checkRegionOverride: data.checkRegionOverride } : {})
      };

      const callableName = data.id ? "updateCheck" : "addCheck";
      const fn = httpsCallable(functions, callableName);
      await fn(checkData);

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
    if (websiteUrl && isValidUrl && hasProcessed && authReady && !hasAutoCreatedRef.current) {
      const currentWebsiteUrl = websiteUrl; // Store the URL before clearing
      hasAutoCreatedRef.current = true;

      // Auto-create the check
      const checkData = {
        name: generateFriendlyName(currentWebsiteUrl),
        url: currentWebsiteUrl.startsWith('http') ? currentWebsiteUrl : `https://${currentWebsiteUrl}`,
        type: 'website' as const,
        checkFrequency: 60, // 1 hour
        httpMethod: 'GET' as const,
        expectedStatusCodes: getDefaultExpectedStatusCodes('website'),
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
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={async () => {
                setUpdatingRegions(true);
                try {
                  const result = await apiClient.updateCheckRegions();
                  if (result.success && result.data) {
                    if (result.data.updated > 0) {
                      toast.success(`Updated ${result.data.updated} check region${result.data.updated === 1 ? '' : 's'}`);
                      // Refresh checks to show updated regions
                      refresh();
                    } else {
                      const debug = (result.data as any)?.debug;
                      if (debug) {
                        const msg = debug.checksNeedingGeo > 0
                          ? `${debug.checksNeedingGeo} check${debug.checksNeedingGeo === 1 ? '' : 's'} missing geo data. They'll be updated on next check run.`
                          : 'All checks already have the correct region';
                        toast.info(msg);
                      } else {
                        toast.info('All checks already have the correct region');
                      }
                    }
                  } else {
                    toast.error(result.error || 'Failed to update check regions');
                  }
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : 'Failed to update check regions');
                } finally {
                  setUpdatingRegions(false);
                }
              }}
              disabled={updatingRegions}
              className="gap-2 cursor-pointer"
              title="Update check regions based on target location"
            >
              <RefreshCw className={`w-4 h-4 ${updatingRegions ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Update Regions</span>
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowBulkImport(true)}
              className="gap-2 cursor-pointer"
              title="Import multiple checks at once"
            >
              <Upload className="w-4 h-4" />
              <span className="hidden sm:inline">Bulk Import</span>
            </Button>
            <Button
              onClick={() => {
                setEditingCheck(null);
                setShowForm(true);
              }}
              className="gap-2 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Add Check</span>
            </Button>
          </div>
        }
      />

      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="Search checks..."
      />

      <Tabs
        value={checksView}
        onValueChange={(v) => setChecksView(v as 'table' | 'folders' | 'map' | 'timeline')}
        className="flex flex-1 flex-col min-h-0"
      >
        {/* View switcher */}
        <div className="px-2 sm:px-4 md:px-6 pt-3">
          <TabsList aria-label="Checks view" className="w-full sm:w-fit">
            <TabsTrigger value="table" className="cursor-pointer min-w-0 sm:min-w-[5.5rem] px-2 sm:px-3 touch-manipulation">
              <List className="size-4 sm:size-4 flex-shrink-0" />
              <span className="hidden sm:inline">Table</span>
            </TabsTrigger>
            <TabsTrigger value="folders" className="cursor-pointer min-w-0 sm:min-w-[5.5rem] px-2 sm:px-3 touch-manipulation">
              <LayoutGrid className="size-4 sm:size-4 flex-shrink-0" />
              <span className="hidden sm:inline">Folders</span>
            </TabsTrigger>
            <TabsTrigger value="map" className="cursor-pointer min-w-0 sm:min-w-[5.5rem] px-2 sm:px-3 touch-manipulation">
              <Map className="size-4 sm:size-4 flex-shrink-0" />
              <span className="hidden sm:inline">Map</span>
            </TabsTrigger>
            {timelineEnabled && (
              <TabsTrigger value="timeline" className="cursor-pointer min-w-0 sm:min-w-[5.5rem] px-2 sm:px-3 touch-manipulation">
                <Activity className="size-4 sm:size-4 flex-shrink-0" />
                <span className="hidden sm:inline">Timeline</span>
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        {/* Checks content */}
        <div className="flex-1 p-4 sm:p-6 min-h-0 max-w-full overflow-x-hidden">
          <div className="max-w-full overflow-x-hidden">
            <TabsContent value="table" className="h-full">
              <CheckTable
                checks={filteredChecks()}
                onDelete={deleteCheck}
                onBulkDelete={bulkDeleteChecks}
                onReorder={reorderChecks}
                onToggleStatus={toggleCheckStatus}
                onBulkToggleStatus={bulkToggleCheckStatus}
                onBulkUpdateSettings={async (ids, settings) => {
                  await bulkUpdateSettings(ids, settings);
                  const count = ids.length;
                  toast.success(`Updated ${count} check${count !== 1 ? 's' : ''}`, {
                    description: 'Settings applied successfully.',
                  });
                }}
                onCheckNow={manualCheck}
                onEdit={(check) => {
                  setEditingCheck(check);
                  setShowForm(true);
                }}
                isNano={nano}
                groupBy={effectiveGroupBy}
                onGroupByChange={(next) => setGroupBy(next)}
                onSetFolder={handleSetFolderDebounced}
                searchQuery={searchQuery}
                onAddFirstCheck={() => {
                  setEditingCheck(null);
                  setShowForm(true);
                }}
                optimisticUpdates={optimisticUpdates}
                folderUpdates={folderUpdates}
                manualChecksInProgress={manualChecksInProgress}
                sortBy={effectiveSortBy}
                onSortChange={handleSortChange}
              />
            </TabsContent>

            <TabsContent value="folders" className="h-auto">
              <CheckFolderView
                checks={filteredChecks()}
                onDelete={deleteCheck}
                onCheckNow={manualCheck}
                onToggleStatus={toggleCheckStatus}
                onEdit={(check) => {
                  setEditingCheck(check);
                  setShowForm(true);
                }}
                isNano={nano}
                onSetFolder={handleSetFolderDebounced}
                onRenameFolder={renameFolder}
                onDeleteFolder={deleteFolder}
                manualChecksInProgress={manualChecksInProgress}
                onAddCheck={() => {
                  setEditingCheck(null);
                  setShowForm(true);
                }}
              />
            </TabsContent>

            <TabsContent value="map" className="h-full">
              <CheckMapView checks={filteredChecks()} />
            </TabsContent>

            {timelineEnabled && (
              <TabsContent value="timeline" className="h-full">
                <FeatureGate
                  enabled={!nano}
                  title="Timeline view is a Nano feature"
                  description="Upgrade to Nano to unlock the timeline view: visualize uptime, downtime, incidents, and response times over time."
                  ctaLabel="Upgrade to Nano"
                  ctaHref="/billing"
                >
                  <CheckTimelineView checks={filteredChecks()} />
                </FeatureGate>
              </TabsContent>
            )}
          </div>
        </div>
      </Tabs>

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

      {/* Bulk Import Modal */}
      <BulkImportModal
        open={showBulkImport}
        onOpenChange={setShowBulkImport}
        onSuccess={refresh}
      />
    </PageContainer>
  );
};

export default Checks;
