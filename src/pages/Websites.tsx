import { useState, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import Console from '../components/console/Console';
import WebsiteForm from '../components/website/WebsiteForm';
import WebsiteList from '../components/website/WebsiteList';
import WebsiteUsage from '../components/website/WebsiteUsage';
import LoadingSkeleton from '../components/layout/LoadingSkeleton';
import TierInfo from '../components/website/TierInfo';
import { useWebsites } from '../hooks/useWebsites';
import { httpsCallable } from "firebase/functions";
import { functions } from '../firebase';
import { Card } from '../components/ui';
import { theme, typography } from '../config/theme';
import { useAuthReady } from '../AuthReadyProvider';

export default function Websites() {
  const { userId } = useAuth();
  const authReady = useAuthReady();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  
  const log = useCallback(
    (msg: string) => setLogs(lgs => [...lgs.slice(-98), `[${new Date().toLocaleTimeString()}] ${msg}`]),
    []
  );

  // Use enhanced hook with direct Firestore operations
  const { 
    websites, 
    loading, 
    addWebsite, 
    updateWebsite, 
    deleteWebsite, 
    reorderWebsites,
    toggleWebsiteStatus
  } = useWebsites(userId ?? null, log);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId || !authReady) return;
    
    try {
      log(`Adding website: ${name} (${url})`);
      await addWebsite(name, url);
      log('Website added successfully.');
    } catch (err: unknown) {
      const error = err as { message?: string };
      log('Error adding website: ' + (error.message || 'Unknown error'));
    }
    setName('');
    setUrl('');
  };

  const handleUpdate = async (id: string, name: string, url: string) => {
    try {
      log(`Updating website: ${name} (${url})`);
      await updateWebsite(id, name, url);
      log('Website updated successfully.');
    } catch (err: unknown) {
      const error = err as { message?: string };
      log('Error updating website: ' + (error.message || 'Unknown error'));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      log('Deleting website...');
      await deleteWebsite(id);
      log('Website deleted successfully.');
    } catch (err: unknown) {
      const error = err as { message?: string };
      log('Error deleting website: ' + (error.message || 'Unknown error'));
    }
  };

  const handleCheckNow = async (id: string) => {
    try {
      log('Manually checking website...');
      const manualCheck = httpsCallable(functions, "manualCheck");
      await manualCheck({ websiteId: id });
      log('Website check completed.');
    } catch (err: unknown) {
      const error = err as { message?: string; code?: string };
      log('Error checking website: ' + (error.message || error.code || 'Unknown error'));
    }
  };

  const handleReorder = async (fromIndex: number, toIndex: number) => {
    try {
      log(`Reordering website from position ${fromIndex + 1} to ${toIndex + 1}`);
      await reorderWebsites(fromIndex, toIndex);
      log('Website order updated successfully.');
    } catch (err: unknown) {
      const error = err as { message?: string };
      log('Error reordering websites: ' + (error.message || 'Unknown error'));
    }
  };

  const handleToggleStatus = async (id: string, disabled: boolean) => {
    if (!userId || !authReady) return;
    
    try {
      log(`Toggling website status: ${disabled ? 'disable' : 'enable'}`);
      await toggleWebsiteStatus(id, disabled);
      log('Website status updated successfully.');
    } catch (err: unknown) {
      const error = err as { message?: string };
      log('Error toggling website status: ' + (error.message || 'Unknown error'));
    }
  };

  // Console website management functions
  const handleConsoleAddWebsite = async (name: string, url: string) => {
    if (!userId || !authReady) throw new Error('Authentication required');
    try {
      log(`Adding website via console: ${name} (${url})`);
      await addWebsite(name, url);
      log('Website added via console.');
    } catch (err: unknown) {
      const error = err as { message?: string };
      const errorMsg = error.message || 'Unknown error';
      log('Error adding website via console: ' + errorMsg);
      throw new Error(errorMsg);
    }
  };

  const handleConsoleEditWebsite = async (id: string, name: string, url: string) => {
    if (!userId || !authReady) throw new Error('Authentication required');
    try {
      log(`Updating website via console: ${name} (${url})`);
      await updateWebsite(id, name, url);
      log('Website updated via console.');
    } catch (err: unknown) {
      const error = err as { message?: string };
      const errorMsg = error.message || 'Unknown error';
      log('Error updating website via console: ' + errorMsg);
      throw new Error(errorMsg);
    }
  };

  const handleConsoleDeleteWebsite = async (id: string) => {
    if (!userId || !authReady) throw new Error('Authentication required');
    try {
      log(`Deleting website via console: ${id}`);
      await deleteWebsite(id);
      log('Website deleted via console.');
    } catch (err: unknown) {
      const error = err as { message?: string };
      const errorMsg = error.message || 'Unknown error';
      log('Error deleting website via console: ' + errorMsg);
      throw new Error(errorMsg);
    }
  };

  return (
    <>
      {/* Top Controls */}
      <div className="flex justify-between items-start mb-6 sm:mb-4">
        <div></div>
        <TierInfo />
      </div>

      {/* Websites Section */}
      <Card className="px-4 sm:px-4 py-6 sm:py-4 mb-12 sm:mb-8">
        <div className="flex flex-col px-4 sm:flex-row sm:justify-between sm:items-center mb-6 sm:mb-4 gap-4 sm:gap-2 sm:gap-0">
          <h1 className={`text-2xl uppercase tracking-widest ${typography.fontFamily.display} ${theme.colors.text.primary}`}>
            Monitored Websites
          </h1>
          <WebsiteUsage 
            websites={websites}
            maxLimit={10} 
            className="sm:ml-4"
          />
        </div>

        {/* Separator between header and form */}
        <div className={`border-b ${theme.colors.border.secondary} mb-8 sm:mb-6`}></div>

        <div className="mb-8 sm:mb-6">
          <WebsiteForm
            name={name}
            url={url}
            onNameChange={setName}
            onUrlChange={setUrl}
            onSubmit={handleAdd}
            disabled={websites.filter(w => !w.disabled).length >= 10 || !authReady}
          />
        </div>
        
        {/* Separator between form and list */}
        <div className={`border-b ${theme.colors.border.secondary} mb-8 sm:mb-6`}></div>
        
        {loading || !authReady ? (
          <div className="mt-6 sm:mt-4" role="status" aria-label="Loading websites">
            <LoadingSkeleton type="list-item" />
            <LoadingSkeleton type="list-item" />
            <LoadingSkeleton type="list-item" />
          </div>
        ) : (
          <WebsiteList
            websites={websites}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onCheckNow={handleCheckNow}
            onToggleStatus={handleToggleStatus}
            onReorder={handleReorder}
          />
        )}
      </Card>

      {/* Console - Always Visible */}
      <div className="mt-12 sm:mt-8">
        <Console 
          logs={logs} 
          websites={websites}
          onAddWebsite={handleConsoleAddWebsite}
          onEditWebsite={handleConsoleEditWebsite}
          onDeleteWebsite={handleConsoleDeleteWebsite}
        />
      </div>
    </>
  );
} 