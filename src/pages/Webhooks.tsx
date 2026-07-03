import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { collection, query, where, onSnapshot, orderBy } from 'firebase/firestore';
import { db } from '../firebase';

import { Link } from 'react-router-dom';
import { Button, Input, Card, CardHeader, CardTitle, CardDescription, CardContent, Collapsible, CollapsibleTrigger, CollapsibleContent, DowngradeBanner, UpgradeBanner } from '../components/ui';
import { PageHeader, PageContainer } from '../components/layout';
import { Plus, Webhook, Info, Search, ChevronDown, Plug, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import type { WebhookCheckFilter, WebhookSettings, TestResult, WebhookEvent } from '../api/types';
import { useChecks } from '../hooks/useChecks';
import { useUserPreferences } from '../hooks/useUserPreferences';
import { usePlan } from '@/hooks/usePlan';
import type { IntegrationScope, WebhookPlatformType } from '../lib/integration-scope';
import {
  labelsForScope,
  platformTypesForScope,
  scopeOfWebhookType,
} from '../lib/integration-scope';

import WebhookTable from '../components/webhook/WebhookTable';
import WebhookForm from '../components/webhook/WebhookForm';

const functions = getFunctions();
const saveWebhookSettings = httpsCallable(functions, 'saveWebhookSettings');
const updateWebhookSettings = httpsCallable(functions, 'updateWebhookSettings');
const deleteWebhook = httpsCallable(functions, 'deleteWebhook');
const bulkDeleteWebhooks = httpsCallable(functions, 'bulkDeleteWebhooks');
const bulkUpdateWebhookStatus = httpsCallable(functions, 'bulkUpdateWebhookStatus');
const testWebhook = httpsCallable(functions, 'testWebhook');

interface WebhooksContentProps {
  // Scope determines which webhook docs are shown on this page and which
  // labels/icons/copy/platforms are used. Both scopes share the same backend
  // Firestore collection (`webhooks`) and the same Cloud Functions.
  scope?: IntegrationScope;
}

const WebhooksContent = ({ scope = 'webhook' }: WebhooksContentProps) => {
  const { userId } = useAuth();
  const { nano } = usePlan();
  const { preferences, updateSorting } = useUserPreferences(userId);
  const labels = labelsForScope(scope);
  const allowedPlatformTypes = platformTypesForScope(scope);
  const scopeIcon = scope === 'webhook' ? Webhook : Plug;
  const [webhooks, setWebhooks] = useState<WebhookSettings[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<WebhookSettings | null>(null);
  const [testingWebhook, setTestingWebhook] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [formLoading, setFormLoading] = useState(false);
  const [optimisticUpdates, setOptimisticUpdates] = useState<string[]>([]);
  const [optimisticDeletes, setOptimisticDeletes] = useState<string[]>([]);
  // Local patches applied on top of the Firestore snapshot so toggles flip
  // instantly instead of waiting for the callable + snapshot round-trip.
  // A patch is dropped once the snapshot reflects it, or on write error.
  const [optimisticPatches, setOptimisticPatches] = useState<Record<string, Partial<Pick<WebhookSettings, 'enabled' | 'events'>>>>({});
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  // Plan limit is counted across BOTH scopes (one Firestore collection, one
  // resource type). Splitting limits per-scope can come later if needed.
  const maxWebhooks = nano ? 50 : 1;
  const atWebhookLimit = !nano && webhooks.length >= maxWebhooks;
  // Only flag downgraded webhooks that belong to THIS scope so the banner
  // doesn't appear on a page that has nothing to do with them.
  const hasDowngradedWebhooks = webhooks.some(
    (w) => w.disabledReason === 'plan_downgrade' && scopeOfWebhookType(w.webhookType) === scope,
  );

  const log = useCallback((_msg: string) => {}, []);
  // Use non-realtime mode to reduce Firestore reads - checks are only needed for the form dropdown
  const { checks } = useChecks(userId ?? null, log, { realtime: false });

  // Snapshot data with optimistic patches applied — what the UI renders.
  const patchedWebhooks = useMemo(
    () => webhooks.map((w) => (optimisticPatches[w.id] ? { ...w, ...optimisticPatches[w.id] } : w)),
    [webhooks, optimisticPatches],
  );

  // Scope-aware filter: only show webhooks whose webhookType belongs to this page's scope.
  const scopedWebhooks = useMemo(
    () => patchedWebhooks.filter((w) => scopeOfWebhookType(w.webhookType) === scope),
    [patchedWebhooks, scope],
  );

  // Filter webhooks based on search query
  const filteredWebhooks = useMemo(() => {
    if (!searchQuery.trim()) return scopedWebhooks.filter(webhook => !optimisticDeletes.includes(webhook.id));

    const q = searchQuery.toLowerCase();
    return scopedWebhooks.filter(webhook =>
      !optimisticDeletes.includes(webhook.id) &&
      (webhook.name.toLowerCase().includes(q) ||
      webhook.url.toLowerCase().includes(q) ||
      webhook.events.some(event => event.toLowerCase().includes(q)))
    );
  }, [scopedWebhooks, searchQuery, optimisticDeletes]);

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
        // Drop optimistic patches the server now reflects (or whose doc is gone)
        setOptimisticPatches((prev) => {
          const ids = Object.keys(prev);
          if (ids.length === 0) return prev;
          const byId = new Map(webhookData.map((w) => [w.id, w]));
          const next = { ...prev };
          let changed = false;
          for (const id of ids) {
            const docData = byId.get(id);
            const patch = prev[id];
            const confirmed = !docData || (
              (patch.enabled === undefined || docData.enabled === patch.enabled) &&
              (patch.events === undefined || JSON.stringify(docData.events) === JSON.stringify(patch.events))
            );
            if (confirmed) { delete next[id]; changed = true; }
          }
          return changed ? next : prev;
        });
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
    webhookType?: WebhookPlatformType;
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
    const webhook = patchedWebhooks.find(w => w.id === id);
    if (!webhook) return;

    // Flip the switch immediately; the snapshot confirms it
    setOptimisticPatches(prev => ({ ...prev, [id]: { ...prev[id], enabled } }));
    setOptimisticUpdates(prev => [...prev, id]);

    try {
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
      // Revert the optimistic flip
      setOptimisticPatches(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } finally {
      // Remove optimistic update
      setOptimisticUpdates(prev => prev.filter(webhookId => webhookId !== id));
    }
  };

  const handleBulkToggleStatus = async (ids: string[], enabled: boolean) => {
    // Flip all switches immediately; the snapshot confirms them
    setOptimisticPatches(prev => {
      const next = { ...prev };
      ids.forEach(id => { next[id] = { ...next[id], enabled }; });
      return next;
    });
    setOptimisticUpdates(prev => [...prev, ...ids]);

    try {
      // Use bulk endpoint instead of N individual calls
      await bulkUpdateWebhookStatus({ ids, enabled });
    } catch (error: any) {
      toast.error(error.message || 'Failed to update webhook statuses');
      setOptimisticPatches(prev => {
        const next = { ...prev };
        ids.forEach(id => { delete next[id]; });
        return next;
      });
    } finally {
      // Remove optimistic updates
      setOptimisticUpdates(prev => prev.filter(webhookId => !ids.includes(webhookId)));
    }
  };

  const handleToggleEvent = async (webhookId: string, event: WebhookEvent) => {
    const webhook = patchedWebhooks.find(w => w.id === webhookId);
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
    
    // Apply the change immediately; the snapshot confirms it
    setOptimisticPatches(prev => ({
      ...prev,
      [webhookId]: { ...prev[webhookId], events: newEvents, enabled: newEnabled },
    }));
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
      setOptimisticPatches(prev => {
        const next = { ...prev };
        delete next[webhookId];
        return next;
      });
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

  const infoBullets = scope === 'webhook' ? (
    <ul className="list-disc pl-4 space-y-2 text-slate-100/80">
      <li>We call every enabled webhook the moment a check changes state (down ↔ up), so you only get meaningful transitions.</li>
      <li>Payloads include the event type, previous status, and full website metadata (URL, response time, detailed status, timestamp) whether you use JSON or the Slack-friendly format.</li>
      <li>SSL monitors emit their own events (ssl_error, ssl_warning) and we only send the ones you enable on that webhook.</li>
      <li>If you add a secret, we sign requests with <code>X-Exit1-Signature = sha256(...)</code> so you can verify authenticity before processing.</li>
      <li>The Test Webhook button sends a real sample payload (no throttling), making it easy to confirm headers, auth, and parsing.</li>
    </ul>
  ) : (
    <ul className="list-disc pl-4 space-y-2 text-slate-100/80">
      <li>Each integration calls the third-party service&apos;s API directly — no endpoint to host on your end.</li>
      <li>PagerDuty and Opsgenie auto-resolve incidents when a check recovers (using dedup keys / aliases) so you don&apos;t need to manually close alerts.</li>
      <li>Pushover maps each check&apos;s severity to priority: P1 outages page at Emergency (repeating until acknowledged), P2 (the default) and other critical events alert at High so they bypass quiet hours, and P4/P5 stay quiet. Recoveries are always capped at High.</li>
      <li>The Test button sends a real notification to the connected service — useful to verify credentials before relying on it.</li>
      <li>Failed deliveries retry with exponential backoff; permanent failures (bad credentials) disable the integration and email you.</li>
    </ul>
  );

  return (
    <PageContainer>
      <PageHeader
        title={labels.title}
        description={labels.description}
        icon={scopeIcon}
        actions={
          <div className="flex items-center gap-2">
            <Button
              onClick={() => setShowForm(true)}
              className="gap-2 cursor-pointer"
              title={atWebhookLimit ? `Free plan limit of ${maxWebhooks} ${labels.titleSingular} reached` : undefined}
              disabled={atWebhookLimit}
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">{labels.addButton}</span>
            </Button>
          </div>
        }
      />

      <div className="space-y-4 sm:space-y-6 p-2 sm:p-4 md:p-6">
        {hasDowngradedWebhooks && !nano && (
          <DowngradeBanner message={labels.downgradeMessage} />
        )}

        {atWebhookLimit && !hasDowngradedWebhooks && (
          <UpgradeBanner message={labels.upgradeLimitMessage(maxWebhooks)} />
        )}

        {/* Cross-link to the sibling page so existing users can find items that
            moved during the Webhooks ↔ Integrations split. */}
        <Link
          to={labels.crossLinkPath}
          className="block text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <span className="inline-flex items-center gap-1.5">
            {labels.crossLinkLabel}
            <ArrowRight className="w-3 h-3" />
          </span>
        </Link>

        <Card className="bg-background/80 border-primary/30 backdrop-blur-md shadow-lg shadow-primary/10">
          <Collapsible open={isInfoOpen} onOpenChange={setIsInfoOpen}>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer hover:bg-primary/5 transition-colors">
                <CardTitle className="flex items-center justify-between text-base font-semibold">
                  <span className="flex items-center gap-2">
                    <Info className="w-4 h-4 text-primary" />
                    {labels.infoCardTitle}
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
                {infoBullets}
              </CardContent>
            </CollapsibleContent>
          </Collapsible>
        </Card>

        <Card className="border-0">
          <CardHeader className="pt-4 pb-4 px-0">
            <CardTitle>{labels.settingsCardTitle}</CardTitle>
            <CardDescription>
              {labels.settingsCardDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-8 pb-4 px-0">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative w-full sm:max-w-xs">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <Input
                  type="text"
                  placeholder={labels.searchPlaceholder}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <div className="text-sm text-muted-foreground">
                {filteredWebhooks.length} {filteredWebhooks.length === 1 ? labels.titleSingular : labels.titlePlural}
              </div>
            </div>

            <div className="min-h-0">
              <div className="max-w-full">
                <WebhookTable
                  webhooks={filteredWebhooks}
                  scope={scope}
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

      <WebhookForm
        onSubmit={handleFormSubmit}
        loading={formLoading}
        isOpen={showForm}
        onClose={handleCloseForm}
        editingWebhook={editingWebhook}
        checks={checks}
        scope={scope}
        allowedPlatformTypes={allowedPlatformTypes}
      />
    </PageContainer>
  );
};

export default WebhooksContent;
