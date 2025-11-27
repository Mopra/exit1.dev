import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { collection, query, where, onSnapshot, orderBy } from 'firebase/firestore';
import { db } from '../firebase';

import { Button, SearchInput, Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui';
import { PageHeader, PageContainer } from '../components/layout';
import { Plus, Webhook, Info } from 'lucide-react';

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
      alert(error.message || 'Failed to delete webhook');
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
      alert(error.message || 'Failed to delete webhooks');
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
      alert(error.message || 'Failed to update webhook status');
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
      alert(error.message || 'Failed to update webhook statuses');
    } finally {
      // Remove optimistic updates
      setOptimisticUpdates(prev => prev.filter(webhookId => !ids.includes(webhookId)));
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
          <Button onClick={() => setShowForm(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Add Webhook</span>
          </Button>
        }
      />

      <div className="space-y-6 p-6">
        <Card className="bg-sky-950/40 border-sky-500/30 text-slate-100 backdrop-blur-md shadow-lg shadow-sky-900/30">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <Info className="w-4 h-4 text-sky-200" />
              How webhooks fire
            </CardTitle>
            <CardDescription className="text-slate-200/80">
              A quick cheat sheet so your automation knows what to expect.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-slate-100/90 space-y-3">
            <ul className="list-disc pl-4 space-y-2 text-slate-100/80">
              <li>We call every enabled webhook the moment a check changes state (down ↔ up or into error), so you only get meaningful transitions.</li>
              <li>Payloads include the event type, previous status, and full website metadata (URL, response time, detailed status, timestamp) whether you use JSON or the Slack-friendly format.</li>
              <li>SSL and domain monitors emit their own events (ssl_error, ssl_warning, domain_expiring, etc.) and we only send the ones you enable on that webhook.</li>
              <li>If you add a secret, we sign requests with <code>X-Exit1-Signature = sha256(...)</code> so you can verify authenticity before processing.</li>
              <li>The Test Webhook button sends a real sample payload (no throttling), making it easy to confirm headers, auth, and parsing.</li>
            </ul>
          </CardContent>
        </Card>

        <SearchInput 
          value={searchQuery} 
          onChange={setSearchQuery} 
          placeholder="Search webhooks..." 
        />

        {/* Webhooks Table */}
        <div className="min-h-0">
          <div className="h-full max-w-full overflow-hidden">
            <WebhookTable
              webhooks={filteredWebhooks()}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onBulkDelete={handleBulkDelete}
              onTest={handleTest}
              onToggleStatus={handleToggleStatus}
              onBulkToggleStatus={handleBulkToggleStatus}
              testingWebhook={testingWebhook}
              testResult={testResult}
              searchQuery={searchQuery}
              onAddFirstWebhook={() => setShowForm(true)}
              optimisticUpdates={optimisticUpdates}
            />
          </div>
        </div>
      </div>

      {/* Add/Edit Webhook Form */}
      <WebhookForm
        onSubmit={handleFormSubmit}
        loading={formLoading}
        isOpen={showForm}
        onClose={handleCloseForm}
        editingWebhook={editingWebhook}
      />
    </PageContainer>
  );
};

export default WebhooksContent;
