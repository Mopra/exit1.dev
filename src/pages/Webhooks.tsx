import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { collection, query, where, onSnapshot, orderBy } from 'firebase/firestore';
import { db } from '../firebase';

import { Button, Input, Card, CardHeader, CardTitle, CardDescription, CardContent, Collapsible, CollapsibleTrigger, CollapsibleContent, DowngradeBanner, UpgradeBanner } from '../components/ui';
import { PageHeader, PageContainer, DocsLink } from '../components/layout';
import { Plus, Webhook, Info, Search, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import type { WebhookCheckFilter, WebhookSettings, TestResult, WebhookEvent } from '../api/types';
import { useChecks } from '../hooks/useChecks';
import { useUserPreferences } from '../hooks/useUserPreferences';
import { usePlan } from '@/hooks/usePlan';

import WebhookTable from '../components/webhook/WebhookTable';
import WebhookForm from '../components/webhook/WebhookForm';

const functions = getFunctions();
const saveWebhookSettings = httpsCallable(functions, 'saveWebhookSettings');
const updateWebhookSettings = httpsCallable(functions, 'updateWebhookSettings');
const deleteWebhook = httpsCallable(functions, 'deleteWebhook');
const bulkDeleteWebhooks = httpsCallable(functions, 'bulkDeleteWebhooks');
const bulkUpdateWebhookStatus = httpsCallable(functions, 'bulkUpdateWebhookStatus');
const testWebhook = httpsCallable(functions, 'testWebhook');

const WebhooksContent = () => {
  const { userId } = useAuth();
  const { nano } = usePlan();
  const { preferences, updateSorting } = useUserPreferences(userId);
  const [webhooks, setWebhooks] = useState<WebhookSettings[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<WebhookSettings | null>(null);
  const [testingWebhook, setTestingWebhook] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [formLoading, setFormLoading] = useState(false);
  const [optimisticUpdates, setOptimisticUpdates] = useState<string[]>([]);
  const [optimisticDeletes, setOptimisticDeletes] = useState<string[]>([]);
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  const maxWebhooks = nano ? 50 : 1;
  const atWebhookLimit = !nano && webhooks.length >= maxWebhooks;
  const hasDowngradedWebhooks = webhooks.some((w) => w.disabledReason === 'plan_downgrade');

  const log = useCallback((_msg: string) => {}, []);
  // Use non-realtime mode to reduce Firestore reads - checks are only needed for the form dropdown
  const { checks } = useChecks(userId ?? null, log, { realtime: false });

  // Filter webhooks based on search query
  const filteredWebhooks = useMemo(() => {
    if (!searchQuery.trim()) return webhooks.filter(webhook => !optimisticDeletes.includes(webhook.id));

    const q = searchQuery.toLowerCase();
    return webhooks.filter(webhook =>
      !optimisticDeletes.includes(webhook.id) &&
      (webhook.name.toLowerCase().includes(q) ||
      webhook.url.toLowerCase().includes(q) ||
      webhook.events.some(event => event.toLowerCase().includes(q)))
    );
  }, [webhooks, searchQuery, optimisticDeletes]);

  const unsubscribeRef = useRef<any>(null);

  useEffect(() => {
    if (!userId) return;

    const subscribe = () => {
      const q = query(
        collection(db, 'webhooks'),
        where('userId', '==', userId),
        orderBy('createdAt', 'desc')
      );
      return onSnapshot(q, (snapshot) => {
        const webhookData = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as WebhookSettings[];
        setWebhooks(webhookData);
      });
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (unsubscribeRef.current) {
          unsubscribeRef.current();
          unsubscribeRef.current = null;
        }
      } else if (!unsubscribeRef.current) {
        unsubscribeRef.current = subscribe();
      }
    };

    unsubscribeRef.current = subscribe();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [userId]);

  const handleFormSubmit = async (data: {
    name: string;
    url: string;
    events: string[];
    checkFilter?: WebhookCheckFilter;
    secret?: string;
    headers?: { [key: string]: string };
    webhookType?: 'slack' | 'discord' | 'teams' | 'pumble' | 'pagerduty' | 'opsgenie' | 'generic';
  }) => {
    if (!userId) return;

    try {
      setFormLoading(true);

      const webhookData = {
        url: data.url,
        name: data.name,
        events: data.events,
        checkFilter: data.checkFilter,
        secret: data.secret || null,
        headers: data.headers || {},
        webhookType: data.webhookType || 'generic'
      };

      if (editingWebhook) {
        await updateWebhookSettings({ ...webhookData, id: editingWebhook.id });
      } else {
        await saveWebhookSettings(webhookData);
      }

      setShowForm(false);
      setEditingWebhook(null);
    } catch (error: any) {
      console.error('Error saving webhook:', error);
    } finally {
      setFormLoading(false);
    }
  };

  const handleEdit = (webhook: WebhookSettings) => {
    setEditingWebhook(webhook);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    try {
      // Add optimistic delete
      setOptimisticDeletes(prev => [...prev, id]);

      await deleteWebhook({ id });
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete webhook');
    } finally {
      // Remove optimistic delete
      setOptimisticDeletes(prev => prev.filter(webhookId => webhookId !== id));
    }
  };

  const handleBulkDelete = async (ids: string[]) => {
    try {
      // Add optimistic deletes
      setOptimisticDeletes(prev => [...prev, ...ids]);

      // Use bulk endpoint instead of N individual calls
      await bulkDeleteWebhooks({ ids });
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete webhooks');
    } finally {
      // Remove optimistic deletes
      setOptimisticDeletes(prev => prev.filter(webhookId => !ids.includes(webhookId)));
    }
  };

  const handleToggleStatus = async (id: string, enabled: boolean) => {
    try {
      const webhook = webhooks.find(w => w.id === id);
      if (!webhook) return;

      // Add optimistic update
      setOptimisticUpdates(prev => [...prev, id]);

      await updateWebhookSettings({
        id: webhook.id,
        url: webhook.url,
        name: webhook.name,
        events: webhook.events,
        secret: webhook.secret || null,
        headers: webhook.headers || {},
        webhookType: webhook.webhookType,
        enabled
      });
    } catch (error: any) {
      toast.error(error.message || 'Failed to update webhook status');
    } finally {
      // Remove optimistic update
      setOptimisticUpdates(prev => prev.filter(webhookId => webhookId !== id));
    }
  };

  const handleBulkToggleStatus = async (ids: string[], enabled: boolean) => {
    try {
      // Add optimistic updates
      setOptimisticUpdates(prev => [...prev, ...ids]);

      // Use bulk endpoint instead of N individual calls
      await bulkUpdateWebhookStatus({ ids, enabled });
    } catch (error: any) {
      toast.error(error.message || 'Failed to update webhook statuses');
    } finally {
      // Remove optimistic updates
      setOptimisticUpdates(prev => prev.filter(webhookId => !ids.includes(webhookId)));
    }
  };

  const handleToggleEvent = async (webhookId: string, event: WebhookEvent) => {
    const webhook = webhooks.find(w => w.id === webhookId);
    if (!webhook) return;

    const currentEvents = new Set(webhook.events);
    
    // If currently disabled, enable it first? 
    // In Emails.tsx, clicking a badge on a disabled check enables the check.
    // Let's follow that pattern if the webhook is disabled.
    let shouldEnable = false;
    if (!webhook.enabled) {
      shouldEnable = true;
    }

    if (currentEvents.has(event)) {
      // Removing event - allow removing all (will disable the webhook)
      currentEvents.delete(event);
    } else {
      // Adding event
      currentEvents.add(event);
    }

    const newEvents = Array.from(currentEvents);
    // If no events remain, disable the webhook; otherwise keep/enable it
    const newEnabled = newEvents.length === 0 ? false : (shouldEnable ? true : webhook.enabled);
    
    // Optimistic update
    setOptimisticUpdates(prev => [...prev, webhookId]);

    try {
      await updateWebhookSettings({
        id: webhook.id,
        url: webhook.url,
        name: webhook.name,
        events: newEvents,
        secret: webhook.secret || null,
        headers: webhook.headers || {},
        webhookType: webhook.webhookType,
        enabled: newEnabled
      });
    } catch (error: any) {
      toast.error(error.message || 'Failed to update webhook events');
    } finally {
      setOptimisticUpdates(prev => prev.filter(id => id !== webhookId));
    }
  };

  const handleTest = async (id: string) => {
    try {
      setTestingWebhook(id);
      setTestResult(null);
      const result = await testWebhook({ id });
      const data = result.data as TestResult;
      setTestResult(data);
      
      // Auto-hide test result after 5 seconds
      setTimeout(() => setTestResult(null), 5000);
    } catch (error: any) {
      setTestResult({
        success: false,
        message: error.message || 'Test failed'
      });
      setTimeout(() => setTestResult(null), 5000);
    } finally {
      setTestingWebhook(null);
    }
  };

  const handleCloseForm = () => {
    setShowForm(false);
    setEditingWebhook(null);
  };

  return (
    <PageContainer>
      <PageHeader 
        title="Webhooks" 
        description="Receive instant notifications when your websites change status"
        icon={Webhook}
        actions={
          <div className="flex items-center gap-2">
            <DocsLink path="/integrations/webhooks" label="Webhook docs" />
            <Button
              onClick={() => setShowForm(true)}
              className="gap-2 cursor-pointer"
              title={atWebhookLimit ? `Free plan limit of ${maxWebhooks} webhook reached` : undefined}
              disabled={atWebhookLimit}
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Add Webhook</span>
            </Button>
          </div>
        }
      />

      <div className="space-y-4 sm:space-y-6 p-2 sm:p-4 md:p-6">
        {hasDowngradedWebhooks && !nano && (
          <DowngradeBanner message="Your webhooks were disabled after downgrading. You can re-enable up to 1 webhook on the Free plan." />
        )}

        {atWebhookLimit && !hasDowngradedWebhooks && (
          <UpgradeBanner message={`You've reached the free plan limit of ${maxWebhooks} webhook. Upgrade to Nano for up to 50 webhooks.`} />
        )}

        <Card className="bg-background/80 border-primary/30 backdrop-blur-md shadow-lg shadow-primary/10">
          <Collapsible open={isInfoOpen} onOpenChange={setIsInfoOpen}>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer hover:bg-primary/5 transition-colors">
                <CardTitle className="flex items-center justify-between text-base font-semibold">
                  <span className="flex items-center gap-2">
                    <Info className="w-4 h-4 text-primary" />
                    How webhooks fire
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 text-primary transition-transform ${isInfoOpen ? 'rotate-180' : ''}`}
                  />
                </CardTitle>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="text-sm text-foreground/90 space-y-3">
                <CardDescription className="text-slate-200/80">
                  A quick cheat sheet so your automation knows what to expect.
                </CardDescription>
                <ul className="list-disc pl-4 space-y-2 text-slate-100/80">
                  <li>We call every enabled webhook the moment a check changes state (down ↔ up), so you only get meaningful transitions.</li>
                  <li>Payloads include the event type, previous status, and full website metadata (URL, response time, detailed status, timestamp) whether you use JSON or the Slack-friendly format.</li>
                  <li>SSL monitors emit their own events (ssl_error, ssl_warning) and we only send the ones you enable on that webhook.</li>
                  <li>If you add a secret, we sign requests with <code>X-Exit1-Signature = sha256(...)</code> so you can verify authenticity before processing.</li>
                  <li>The Test Webhook button sends a real sample payload (no throttling), making it easy to confirm headers, auth, and parsing.</li>
                </ul>
              </CardContent>
            </CollapsibleContent>
          </Collapsible>
        </Card>

        {/* Webhooks Settings */}
        <Card className="border-0">
          <CardHeader className="pt-4 pb-4 px-0">
            <CardTitle>Webhook Settings</CardTitle>
            <CardDescription>
              Configure which events trigger webhook notifications for your endpoints.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-8 pb-4 px-0">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative w-full sm:max-w-xs">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <Input
                  type="text"
                  placeholder="Search webhooks..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <div className="text-sm text-muted-foreground">
                {filteredWebhooks.length} {filteredWebhooks.length === 1 ? 'webhook' : 'webhooks'}
              </div>
            </div>

            <div className="min-h-0">
              <div className="max-w-full">
                <WebhookTable
                  webhooks={filteredWebhooks}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onBulkDelete={handleBulkDelete}
                  onTest={handleTest}
                  onToggleStatus={handleToggleStatus}
                  onToggleEvent={handleToggleEvent}
                  onBulkToggleStatus={handleBulkToggleStatus}
                  testingWebhook={testingWebhook}
                  testResult={testResult}
                  searchQuery={searchQuery}
                  onAddFirstWebhook={() => setShowForm(true)}
                  optimisticUpdates={optimisticUpdates}
                  sortBy={preferences?.sorting?.webhooks}
                  onSortChange={(sortOption) => updateSorting('webhooks', sortOption)}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Add/Edit Webhook Form */}
      <WebhookForm
        onSubmit={handleFormSubmit}
        loading={formLoading}
        isOpen={showForm}
        onClose={handleCloseForm}
        editingWebhook={editingWebhook}
        checks={checks}
      />
    </PageContainer>
  );
};

export default WebhooksContent;
