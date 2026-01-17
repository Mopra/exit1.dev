import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { collection, query, where, onSnapshot, orderBy } from 'firebase/firestore';
import { db } from '../firebase';

import { Button, Input, Card, CardHeader, CardTitle, CardDescription, CardContent, Collapsible, CollapsibleTrigger, CollapsibleContent } from '../components/ui';
import { PageHeader, PageContainer } from '../components/layout';
import { Plus, Webhook, Info, Search, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import type { WebhookCheckFilter } from '../api/types';
import { useChecks } from '../hooks/useChecks';

// import LoadingSkeleton from '../components/layout/LoadingSkeleton';
import WebhookTable from '../components/webhook/WebhookTable';
import WebhookForm from '../components/webhook/WebhookForm';
// Removed FontAwesome in favor of Lucide icons for consistency

interface WebhookSettings {
  id: string;
  url: string;
  name: string;
  enabled: boolean;
  events: string[];
  checkFilter?: WebhookCheckFilter;
  secret?: string;
  headers?: { [key: string]: string };
  webhookType?: 'slack' | 'discord' | 'generic';
  createdAt: number;
  updatedAt: number;
}

interface TestResult {
  success: boolean;
  message?: string;
  statusCode?: number;
  responseTime?: number;
}

const WebhooksContent = () => {
  const { userId } = useAuth();
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

  const log = useCallback((msg: string) => console.log(`[Webhooks] ${msg}`), []);
  const { checks } = useChecks(userId ?? null, log);

  const functions = getFunctions();
  const saveWebhookSettings = httpsCallable(functions, 'saveWebhookSettings');
  const updateWebhookSettings = httpsCallable(functions, 'updateWebhookSettings');
  const deleteWebhook = httpsCallable(functions, 'deleteWebhook');
  const testWebhook = httpsCallable(functions, 'testWebhook');

  // Filter webhooks based on search query
  const filteredWebhooks = useCallback(() => {
    if (!searchQuery.trim()) return webhooks.filter(webhook => !optimisticDeletes.includes(webhook.id));
    
    const query = searchQuery.toLowerCase();
    return webhooks.filter(webhook => 
      !optimisticDeletes.includes(webhook.id) &&
      (webhook.name.toLowerCase().includes(query) ||
      webhook.url.toLowerCase().includes(query) ||
      webhook.events.some(event => event.toLowerCase().includes(query)))
    );
  }, [webhooks, searchQuery, optimisticDeletes]);

  const unsubscribeRef = useRef<any>(null);

  useEffect(() => {
    if (!userId) return;

    // Only set up real-time listener when tab is active
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Tab is hidden, unsubscribe to save resources
        if (unsubscribeRef.current) {
          unsubscribeRef.current();
          unsubscribeRef.current = null;
        }
      } else {
        // Tab is visible, set up listener
        if (!unsubscribeRef.current) {
          const q = query(
            collection(db, 'webhooks'),
            where('userId', '==', userId),
            orderBy('createdAt', 'desc')
          );

          const unsubscribe = onSnapshot(q, (snapshot) => {
            const webhookData = snapshot.docs.map(doc => ({
              id: doc.id,
              ...doc.data()
            })) as WebhookSettings[];
            setWebhooks(webhookData);
          });

          unsubscribeRef.current = unsubscribe;
        }
      }
    };

    // Set up initial listener
    const q = query(
      collection(db, 'webhooks'),
      where('userId', '==', userId),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const webhookData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as WebhookSettings[];
      setWebhooks(webhookData);
    });

    unsubscribeRef.current = unsubscribe;

    // Listen for tab visibility changes
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
    webhookType?: 'slack' | 'discord' | 'generic';
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

      for (const id of ids) {
        await deleteWebhook({ id });
      }
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

      for (const id of ids) {
        const webhook = webhooks.find(w => w.id === id);
        if (!webhook) continue;

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
      }
    } catch (error: any) {
      toast.error(error.message || 'Failed to update webhook statuses');
    } finally {
      // Remove optimistic updates
      setOptimisticUpdates(prev => prev.filter(webhookId => !ids.includes(webhookId)));
    }
  };

  const handleToggleEvent = async (webhookId: string, event: string) => {
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
      // Removing event
      if (currentEvents.size <= 1) {
        toast.error('At least one event type is required');
        return;
      }
      currentEvents.delete(event);
    } else {
      // Adding event
      currentEvents.add(event);
    }

    const newEvents = Array.from(currentEvents);
    
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
        enabled: shouldEnable ? true : webhook.enabled
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
          <Button onClick={() => setShowForm(true)} className="gap-2 cursor-pointer">
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Add Webhook</span>
          </Button>
        }
      />

      <div className="space-y-6 p-6">
        <Card className="bg-sky-950/40 border-sky-500/30 text-slate-100 backdrop-blur-md shadow-lg shadow-sky-900/30">
          <Collapsible open={isInfoOpen} onOpenChange={setIsInfoOpen}>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer hover:bg-white/5 transition-colors">
                <CardTitle className="flex items-center justify-between text-base font-semibold">
                  <span className="flex items-center gap-2">
                    <Info className="w-4 h-4 text-sky-200" />
                    How webhooks fire
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 text-sky-200 transition-transform ${isInfoOpen ? 'rotate-180' : ''}`}
                  />
                </CardTitle>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="text-sm text-slate-100/90 space-y-3">
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
              <div className="relative max-w-xs">
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
                {filteredWebhooks().length} {filteredWebhooks().length === 1 ? 'webhook' : 'webhooks'}
              </div>
            </div>

            <div className="min-h-0">
              <div className="max-w-full">
                <WebhookTable
                  webhooks={filteredWebhooks()}
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
