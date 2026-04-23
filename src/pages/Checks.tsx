import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useLocation, useNavigate } from 'react-router-dom';
import CheckForm from '../components/check/CheckForm';
import CheckTable from '../components/check/CheckTable';
import LoadingSkeleton from '../components/layout/LoadingSkeleton';
import { useChecks } from '../hooks/useChecks';
import { useWebsiteUrl } from '../hooks/useWebsiteUrl';
import { httpsCallable } from "firebase/functions";
import { functions } from '../firebase';
import { Button, DowngradeBanner, ErrorModal, SearchInput, UpgradeBanner } from '../components/ui';
import { PageHeader, PageContainer, DocsLink } from '../components/layout';
import { Plus, Globe, Upload, Download } from 'lucide-react';
import { useAuthReady } from '../AuthReadyProvider';
import { parseFirebaseError } from '../utils/errorHandler';
import type { ParsedError } from '../utils/errorHandler';
import { toast } from 'sonner';
import type { Website } from '../types';
import { usePlan } from "@/hooks/usePlan";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useUserPreferences } from "../hooks/useUserPreferences";
import { getDefaultExpectedStatusCodes, getDefaultHttpMethod } from '../lib/check-defaults';
import { generateFriendlyName } from '../lib/check-utils';
import BulkImportModal from '../components/check/BulkImportModal';
import { ExportChecksModal, type ExportSubmitParams } from '../components/check/ExportChecksModal';
import { MaintenanceDialog } from '../components/check/MaintenanceDialog';

const Checks: React.FC = () => {
  const { userId } = useAuth();
  const authReady = useAuthReady();
  const { websiteUrl, isValidUrl, hasProcessed, clearWebsiteUrl } = useWebsiteUrl();
  const [formLoading, setFormLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingCheck, setEditingCheck] = useState<Website | null>(null);
  const [duplicatingCheck, setDuplicatingCheck] = useState<Website | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const hasAutoCreatedRef = React.useRef(false);
  const [pendingCheck, setPendingCheck] = useState<{ name: string; url: string } | null>(null);
  const { nano, pro } = usePlan();
  const [isExporting, setIsExporting] = useState(false);
  const { preferences, loading: preferencesLoading, updateSorting } = useUserPreferences(userId);
  // Local state for immediate UI updates - Firestore is only for persistence
  // Initialize to null so we know when to sync from Firestore vs when user has made a choice
  const [checksSortBy, setChecksSortBy] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useLocalStorage<'none' | 'folder'>('checks-group-by-v1', 'none');
  const effectiveGroupBy = groupBy;
  const [errorModal, setErrorModal] = useState<{
    isOpen: boolean;
    error: ParsedError;
  }>({
    isOpen: false,
    error: { title: '', message: '' }
  });
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [maintenanceDialog, setMaintenanceDialog] = useState<{
    open: boolean;
    checks: Website[];
  }>({ open: false, checks: [] });
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);

  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const state = location.state as { intent?: string } | null;
    if (state?.intent === 'create-check') {
      setShowForm(true);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location, navigate]);

  // Use enhanced hook with direct Firestore operations
  const {
    checks,
    deleteCheck,
    bulkDeleteChecks,
    reorderAndCommit,
    toggleCheckStatus,
    toggleMaintenanceMode,
    scheduleMaintenanceWindow,
    cancelScheduledMaintenance,
    setRecurringMaintenance,
    deleteRecurringMaintenance,
    bulkToggleCheckStatus,
    updateCheck,
    bulkUpdateSettings,
    bulkMoveToFolder,
    manualCheck,
    setCheckFolder: _setCheckFolder, // Available for non-debounced use cases
    debouncedSetCheckFolder,
    flushPendingFolderUpdates,
    refresh,
    optimisticUpdates,
    folderUpdates,
    manualChecksInProgress
  } = useChecks(userId ?? null, () => {});

  const hasFolders = React.useMemo(() => (
    checks.some((check) => (check.folder ?? '').trim().length > 0)
  ), [checks]);

  const maxChecks = nano ? 200 : 10;
  const atCheckLimit = !nano && checks.length >= maxChecks;
  const isGrandfathered = !nano && checks.length > maxChecks;
  const hasDowngradedChecks = React.useMemo(() =>
    checks.some((c) => c.disabledReason === 'plan_downgrade'),
  [checks]);

  // Wrapper for debounced folder updates that matches the expected signature
  // (the debounced version returns a cleanup function, but components expect void)
  const handleSetFolderDebounced = React.useCallback((id: string, folder: string | null) => {
    debouncedSetCheckFolder(id, folder);
  }, [debouncedSetCheckFolder]);

  // Maintenance mode: handle single check or bulk entry/exit
  const handleToggleMaintenance = useCallback((check: Website) => {
    if (check.maintenanceMode) {
      // Exit maintenance immediately (no dialog needed)
      if (!nano) {
        toast('Maintenance mode is a Nano feature', {
          description: 'Suppress alerts during planned downtime.',
          action: { label: 'Upgrade', onClick: () => window.location.href = '/billing' },
        });
        return;
      }
      toggleMaintenanceMode(check.id, false)
        .then(() => toast.success('Maintenance mode disabled'))
        .catch((err: Error) => toast.error(err.message || 'Failed to exit maintenance'));
    } else {
      // Show dialog to pick duration
      if (!nano) {
        toast('Maintenance mode is a Nano feature', {
          description: 'Suppress alerts during planned downtime.',
          action: { label: 'Upgrade', onClick: () => window.location.href = '/billing' },
        });
        return;
      }
      setMaintenanceDialog({ open: true, checks: [check] });
    }
  }, [nano, toggleMaintenanceMode]);

  const handleBulkToggleMaintenance = useCallback((selected: Website[], enabled: boolean) => {
    if (!nano) {
      toast('Maintenance mode is a Nano feature', {
        description: 'Suppress alerts during planned downtime.',
        action: { label: 'Upgrade', onClick: () => window.location.href = '/billing' },
      });
      return;
    }
    if (enabled) {
      setMaintenanceDialog({ open: true, checks: selected });
    } else {
      // Exit maintenance for all selected
      Promise.all(
        selected
          .filter(c => c.maintenanceMode)
          .map(c => toggleMaintenanceMode(c.id, false))
      )
        .then(() => toast.success(`Exited maintenance for ${selected.filter(c => c.maintenanceMode).length} check(s)`))
        .catch((err: Error) => toast.error(err.message || 'Failed to exit maintenance'));
    }
  }, [nano, toggleMaintenanceMode]);

  const handleMaintenanceConfirm = useCallback(async (result: import('../components/check/MaintenanceDialog').MaintenanceDialogResult) => {
    setMaintenanceLoading(true);
    try {
      const checks = maintenanceDialog.checks;
      const count = checks.length;
      if (result.mode === 'now') {
        await Promise.all(checks.map(c => toggleMaintenanceMode(c.id, true, result.duration!, result.reason)));
        toast.success(`Maintenance mode enabled for ${count} check${count !== 1 ? 's' : ''}`);
      } else if (result.mode === 'scheduled') {
        await Promise.all(checks.map(c => scheduleMaintenanceWindow(c.id, result.startTime!, result.duration!, result.reason)));
        toast.success(`Maintenance scheduled for ${count} check${count !== 1 ? 's' : ''}`);
      } else if (result.mode === 'recurring') {
        await Promise.all(checks.map(c => setRecurringMaintenance(c.id, result.daysOfWeek!, result.startTimeMinutes!, result.durationMinutes!, result.timezone!, result.reason)));
        toast.success(`Recurring maintenance set for ${count} check${count !== 1 ? 's' : ''}`);
      }
      setMaintenanceDialog({ open: false, checks: [] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to configure maintenance');
    } finally {
      setMaintenanceLoading(false);
    }
  }, [maintenanceDialog.checks, toggleMaintenanceMode, scheduleMaintenanceWindow, setRecurringMaintenance]);

  const handleCancelScheduledMaintenance = useCallback(async (check: Website) => {
    try {
      await cancelScheduledMaintenance(check.id);
      toast.success('Scheduled maintenance cancelled');
    } catch (err: any) {
      toast.error(err.message || 'Failed to cancel scheduled maintenance');
    }
  }, [cancelScheduledMaintenance]);

  const handleDeleteRecurringMaintenance = useCallback(async (check: Website) => {
    try {
      await deleteRecurringMaintenance(check.id);
      toast.success('Recurring maintenance deleted');
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete recurring maintenance');
    }
  }, [deleteRecurringMaintenance]);

  const handleEditRecurringMaintenance = useCallback((check: Website) => {
    setMaintenanceDialog({ open: true, checks: [check] });
  }, []);

  const handleDuplicate = useCallback((check: Website) => {
    setEditingCheck(null);
    setDuplicatingCheck(check);
    setShowForm(true);
  }, []);

  const handleRefreshMetadata = useCallback(async (check: Website) => {
    const toastId = toast.loading(`Fetching geo data for ${check.name || check.url}…`);
    try {
      const { apiClient } = await import('../api/client');
      const result = await apiClient.refreshCheckMetadata(check.id);
      if (!result.success) {
        toast.error(result.error || 'Failed to refresh geo data', { id: toastId });
        return;
      }
      const data = result.data;
      if (data?.hasGeo) {
        const where = [data.city, data.country].filter(Boolean).join(', ');
        toast.success(where ? `Geo data updated: ${where}` : 'Geo data updated', { id: toastId });
      } else if (data?.ip) {
        toast.warning(`Resolved ${data.ip} but geo lookup returned no data`, { id: toastId });
      } else {
        toast.warning(data?.message || 'Could not resolve target', { id: toastId });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to refresh geo data', { id: toastId });
    }
  }, []);

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
      .then(() => {})
      .catch((err) => {
        console.error('[Checks] Failed to persist sort preference:', err);
        toast.error('Failed to save sort preference');
      });
  }, [updateSorting]);

  // Filter checks based on search query
  const filteredChecks = useMemo(() => {
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
    type: 'website' | 'rest_endpoint' | 'tcp' | 'udp' | 'ping' | 'websocket' | 'redirect' | 'dns' | 'heartbeat';
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
    redirectValidation?: {
      expectedTarget: string;
      matchMode: 'contains' | 'exact';
    } | null;
    immediateRecheckEnabled?: boolean;
    downConfirmationAttempts?: number;
    cacheControlNoCache?: boolean;
    checkRegionOverride?: 'us-central1' | 'europe-west1' | 'asia-southeast1' | 'vps-eu-1' | null;
    timezone?: string | null;
    dnsRecordTypes?: string[];
  }) => {
    if (!userId || !authReady) {
      console.error('Cannot add check: userId or authReady is missing');
      throw new Error('Authentication required');
    }

    setFormLoading(true);
    try {
      const immediateRecheckEnabled =
        data.immediateRecheckEnabled === undefined ? undefined : data.immediateRecheckEnabled === true;
      const isHttpCheck = data.type === 'website' || data.type === 'rest_endpoint' || data.type === 'redirect';
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
            ...(data.redirectValidation !== undefined ? { redirectValidation: data.redirectValidation } : {}),
          }
          : {}),
        ...(immediateRecheckEnabled !== undefined ? { immediateRecheckEnabled } : {}),
        ...(data.downConfirmationAttempts !== undefined ? { downConfirmationAttempts: data.downConfirmationAttempts } : {}),
        ...(data.responseTimeLimit !== undefined ? { responseTimeLimit: data.responseTimeLimit } : {}),
        ...(data.checkRegionOverride !== undefined ? { checkRegionOverride: data.checkRegionOverride } : {}),
        ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
        ...(data.dnsRecordTypes?.length ? { dnsRecordTypes: data.dnsRecordTypes } : {}),
      };

      if (data.id) {
        await updateCheck({
          id: data.id,
          url: data.url,
          name: data.name,
          type: data.type,
          checkFrequency: data.checkFrequency || 60,
          ...(isHttpCheck ? {
            httpMethod: data.httpMethod || getDefaultHttpMethod(data.type),
            expectedStatusCodes: data.expectedStatusCodes || getDefaultExpectedStatusCodes(data.type),
            requestHeaders: data.requestHeaders || {},
            requestBody: data.requestBody || '',
            responseValidation: data.responseValidation || {},
            cacheControlNoCache: data.cacheControlNoCache === true,
            ...(data.redirectValidation !== undefined ? { redirectValidation: data.redirectValidation ?? undefined } : {}),
          } : {}),
          ...(immediateRecheckEnabled !== undefined ? { immediateRecheckEnabled } : {}),
          ...(data.downConfirmationAttempts !== undefined ? { downConfirmationAttempts: data.downConfirmationAttempts } : {}),
          ...(data.responseTimeLimit !== undefined ? { responseTimeLimit: data.responseTimeLimit } : {}),
          ...(data.checkRegionOverride !== undefined ? { checkRegionOverride: data.checkRegionOverride } : {}),
          ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
          ...(data.dnsRecordTypes?.length ? { dnsRecordTypes: data.dnsRecordTypes } : {}),
        });
      } else {
        const fn = httpsCallable(functions, "addCheck");
        await fn(checkData);
      }

      // Show success toast
      toast.success(`Check ${data.id ? 'updated' : 'added'} successfully!`, {
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
      const friendlyName = generateFriendlyName(currentWebsiteUrl);
      const fullUrl = currentWebsiteUrl.startsWith('http') ? currentWebsiteUrl : `https://${currentWebsiteUrl}`;
      const checkData = {
        name: friendlyName,
        url: fullUrl,
        type: 'website' as const,
        checkFrequency: 60, // 1 hour
        httpMethod: 'GET' as const,
        expectedStatusCodes: getDefaultExpectedStatusCodes('website'),
        requestHeaders: {},
        requestBody: '',
        responseValidation: {}
      };

      // Show pending row while check is being created
      setPendingCheck({ name: friendlyName, url: fullUrl });

      // Call handleAdd directly
      handleUpsert(checkData)
        .then(() => setPendingCheck(null))
        .catch(() => setPendingCheck(null));

      // Clear the website URL
      clearWebsiteUrl();

      // Note: handleAdd will show its own success toast, so we don't need this one
    }
  }, [websiteUrl, isValidUrl, hasProcessed, authReady, clearWebsiteUrl]);

  // Pro+ CSV export. The modal collects columns / date-range / include-history,
  // then we call the backend and either download a single CSV (checks only) or
  // bundle checks + history into a zip on the client. See
  // `functions/src/csv-export.ts` for the round-trip contract with BulkImport.
  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
  }, []);

  const handleExportSubmit = useCallback(async (params: ExportSubmitParams) => {
    if (!pro) return;
    setIsExporting(true);
    try {
      const { apiClient } = await import('../api/client');
      const result = await apiClient.exportChecksCsv(params);
      if (!result.success || !result.data) {
        toast.error(result.error || 'Failed to export checks');
        return;
      }
      const {
        checksCsv,
        checksFilename,
        checksRowCount,
        historyCsv,
        historyFilename,
        historyRowCount,
        historyTruncated,
      } = result.data;

      if (historyCsv && historyFilename) {
        // Bundle both into a zip so the user gets a single download.
        const { default: JSZip } = await import('jszip');
        const zip = new JSZip();
        zip.file(checksFilename, checksCsv);
        zip.file(historyFilename, historyCsv);
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const zipName = checksFilename.replace(/\.csv$/, '') + '-with-history.zip';
        downloadBlob(zipBlob, zipName);
        const msg = historyTruncated
          ? `Exported ${checksRowCount} check${checksRowCount !== 1 ? 's' : ''} + ${historyRowCount?.toLocaleString() ?? 0} runs (truncated — window exceeded 500k rows)`
          : `Exported ${checksRowCount} check${checksRowCount !== 1 ? 's' : ''} + ${historyRowCount?.toLocaleString() ?? 0} run${historyRowCount === 1 ? '' : 's'}`;
        if (historyTruncated) toast.warning(msg);
        else toast.success(msg);
      } else {
        downloadBlob(new Blob([checksCsv], { type: 'text/csv;charset=utf-8' }), checksFilename);
        toast.success(`Exported ${checksRowCount} check${checksRowCount !== 1 ? 's' : ''}`);
      }
      setShowExport(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to export checks');
    } finally {
      setIsExporting(false);
    }
  }, [pro, downloadBlob]);

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
            <DocsLink path="/monitoring" label="Monitoring docs" />
            <Button
              variant="outline"
              onClick={() => setShowBulkImport(true)}
              className="gap-2 cursor-pointer"
              title={atCheckLimit ? "Upgrade to Nano to add more checks" : "Import multiple checks at once"}
              disabled={atCheckLimit}
            >
              <Upload className="w-4 h-4" />
              <span className="hidden sm:inline">Bulk Import</span>
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowExport(true)}
              className="gap-2 cursor-pointer"
              title={pro ? "Export checks to CSV" : "Available on Pro"}
              disabled={!pro || isExporting || checks.length === 0}
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">{isExporting ? 'Exporting…' : 'Export'}</span>
            </Button>
            <Button
              onClick={() => {
                setEditingCheck(null);
                setDuplicatingCheck(null);
                setShowForm(true);
              }}
              className="gap-2 cursor-pointer"
              title={atCheckLimit ? "Upgrade to Nano to add more checks" : undefined}
              disabled={atCheckLimit}
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

      {hasDowngradedChecks && !nano && (
        <div className="px-2 sm:px-4 md:px-6 pt-3">
          <DowngradeBanner message="Your plan was downgraded to Free. All checks have been disabled and reset to 5-minute intervals. You can re-enable up to 10 checks." />
        </div>
      )}

      {atCheckLimit && !hasDowngradedChecks && (
        <div className="px-2 sm:px-4 md:px-6 pt-3">
          <UpgradeBanner message={isGrandfathered
            ? `Your free plan now includes ${maxChecks} checks. Your existing ${checks.length} checks will keep running, but upgrade to Nano to add more.`
            : `You've reached the free plan limit of ${maxChecks} checks. Upgrade to Nano to monitor up to 200.`
          } />
        </div>
      )}

      <div className="flex flex-1 flex-col min-h-0">
        <div className="flex-1 p-2 sm:p-4 md:p-6 min-h-0 max-w-full overflow-x-hidden">
          <div className="max-w-full overflow-x-hidden">
            <CheckTable
              checks={filteredChecks}
              onDelete={deleteCheck}
              onBulkDelete={bulkDeleteChecks}
              onReorderAndCommit={reorderAndCommit}
              onToggleStatus={toggleCheckStatus}
              onToggleMaintenance={handleToggleMaintenance}
              onBulkToggleMaintenance={handleBulkToggleMaintenance}
              onCancelScheduledMaintenance={handleCancelScheduledMaintenance}
              onEditRecurringMaintenance={handleEditRecurringMaintenance}
              onDeleteRecurringMaintenance={handleDeleteRecurringMaintenance}
              onBulkToggleStatus={bulkToggleCheckStatus}
              onBulkUpdateSettings={async (ids, settings) => {
                await bulkUpdateSettings(ids, settings);
                const count = ids.length;
                toast.success(`Updated ${count} check${count !== 1 ? 's' : ''}`, {
                  description: 'Settings applied successfully.',
                });
              }}
              onBulkMoveToFolder={async (ids, folder) => {
                await bulkMoveToFolder(ids, folder);
                const count = ids.length;
                toast.success(`Moved ${count} check${count !== 1 ? 's' : ''} to ${folder ?? 'root'}`, {
                  description: 'Folder updated successfully.',
                });
              }}
              onCheckNow={manualCheck}
              onRefreshMetadata={handleRefreshMetadata}
              onEdit={(check) => {
                setEditingCheck(check);
                setDuplicatingCheck(null);
                setShowForm(true);
              }}
              onDuplicate={handleDuplicate}
              isNano={nano}
              groupBy={effectiveGroupBy}
              onGroupByChange={(next) => setGroupBy(next)}
              onSetFolder={handleSetFolderDebounced}
              searchQuery={searchQuery}
              onAddFirstCheck={() => {
                setEditingCheck(null);
                setDuplicatingCheck(null);
                setShowForm(true);
              }}
              optimisticUpdates={optimisticUpdates}
              folderUpdates={folderUpdates}
              manualChecksInProgress={manualChecksInProgress}
              sortBy={effectiveSortBy}
              onSortChange={handleSortChange}
              pendingCheck={pendingCheck}
            />
          </div>
        </div>
      </div>

      {/* Add Check Form Slide-out */}
      <CheckForm
        mode={editingCheck ? 'edit' : 'create'}
        initialCheck={editingCheck}
        duplicateFrom={duplicatingCheck}
        onSubmit={handleUpsert}
        loading={formLoading}
        isOpen={showForm}
        onClose={() => {
          setShowForm(false);
          setEditingCheck(null);
          setDuplicatingCheck(null);
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

      {/* Export Checks Modal */}
      <ExportChecksModal
        open={showExport}
        onOpenChange={(open) => {
          if (!isExporting) setShowExport(open);
        }}
        onSubmit={handleExportSubmit}
        checkCount={checks.length}
        isSubmitting={isExporting}
      />

      {/* Maintenance Mode Dialog */}
      <MaintenanceDialog
        open={maintenanceDialog.open}
        onOpenChange={(open) => {
          if (!open) setMaintenanceDialog({ open: false, checks: [] });
        }}
        onConfirm={handleMaintenanceConfirm}
        checkName={maintenanceDialog.checks.length === 1 ? (maintenanceDialog.checks[0].name || maintenanceDialog.checks[0].url) : undefined}
        loading={maintenanceLoading}
        existingRecurring={maintenanceDialog.checks.length === 1 ? maintenanceDialog.checks[0].maintenanceRecurring : undefined}
        defaultTab={maintenanceDialog.checks.length === 1 && maintenanceDialog.checks[0].maintenanceRecurring ? 'recurring' : undefined}
      />
    </PageContainer>
  );
};

export default Checks;
