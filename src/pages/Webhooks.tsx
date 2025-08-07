import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { collection, query, where, onSnapshot, orderBy } from 'firebase/firestore';
import { db } from '../firebase';

import { Button, Input } from '../components/ui';

import LoadingSkeleton from '../components/layout/LoadingSkeleton';
import WebhookTable from '../components/webhook/WebhookTable';
import WebhookForm from '../components/webhook/WebhookForm';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faSearch } from '@fortawesome/free-solid-svg-icons';

interface WebhookSettings {
  id: string;
  url: string;
  name: string;
  enabled: boolean;
  events: string[];
  secret?: string;
  headers?: { [key: string]: string };
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
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<WebhookSettings | null>(null);
  const [testingWebhook, setTestingWebhook] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [formLoading, setFormLoading] = useState(false);

  const functions = getFunctions();
  const saveWebhookSettings = httpsCallable(functions, 'saveWebhookSettings');
  const updateWebhookSettings = httpsCallable(functions, 'updateWebhookSettings');
  const deleteWebhook = httpsCallable(functions, 'deleteWebhook');
  const testWebhook = httpsCallable(functions, 'testWebhook');

  // Filter webhooks based on search query
  const filteredWebhooks = useCallback(() => {
    if (!searchQuery.trim()) return webhooks;
    
    const query = searchQuery.toLowerCase();
    return webhooks.filter(webhook => 
      webhook.name.toLowerCase().includes(query) ||
      webhook.url.toLowerCase().includes(query) ||
      webhook.events.some(event => event.toLowerCase().includes(query))
    );
  }, [webhooks, searchQuery]);

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
            setLoading(false);
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
      setLoading(false);
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
  }) => {
    if (!userId) return;

    try {
      setFormLoading(true);

      const webhookData = {
        url: data.url,
        name: data.name,
        events: data.events,
        secret: data.secret || null,
        headers: data.headers || {}
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
      await deleteWebhook({ id });
    } catch (error: any) {
      alert(error.message || 'Failed to delete webhook');
    }
  };

  const handleBulkDelete = async (ids: string[]) => {
    try {
      for (const id of ids) {
        await deleteWebhook({ id });
      }
    } catch (error: any) {
      alert(error.message || 'Failed to delete webhooks');
    }
  };

  const handleToggleStatus = async (id: string, enabled: boolean) => {
    try {
      const webhook = webhooks.find(w => w.id === id);
      if (!webhook) return;

      await updateWebhookSettings({
        id: webhook.id,
        url: webhook.url,
        name: webhook.name,
        events: webhook.events,
        secret: webhook.secret || null,
        headers: webhook.headers || {},
        enabled
      });
    } catch (error: any) {
      alert(error.message || 'Failed to update webhook status');
    }
  };

  const handleBulkToggleStatus = async (ids: string[], enabled: boolean) => {
    try {
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
          enabled
        });
      }
    } catch (error: any) {
      alert(error.message || 'Failed to update webhook statuses');
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
    <div className="flex flex-1 flex-col h-full overflow-hidden min-w-0 w-full max-w-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 p-4 sm:p-6 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Webhooks</h1>
          <p className="text-sm text-muted-foreground hidden sm:block">
            Receive instant notifications when your websites change status
          </p>
        </div>
        <Button onClick={() => setShowForm(true)} className="gap-2 shrink-0">
          <FontAwesomeIcon icon={faPlus} className="w-4 h-4" />
          <span className="hidden sm:inline">Add Webhook</span>
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
            placeholder="Search webhooks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      {/* Webhooks Table */}
      <div className="flex-1 px-4 sm:px-6 pb-4 sm:pb-6 pt-4 min-h-0">
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
          />
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
    </div>
  );
};

export default WebhooksContent;
