import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { collection, query, where, onSnapshot, orderBy } from 'firebase/firestore';
import { db } from '../firebase';

import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Label from '../components/ui/Label';
import Modal from '../components/ui/Modal';
import { useTooltip } from '../components/ui/Tooltip';
import LoadingSkeleton from '../components/layout/LoadingSkeleton';
import WebhookTable from '../components/webhook/WebhookTable';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { theme, typography } from '../config/theme';
import { faCheckCircle, faPauseCircle } from '@fortawesome/free-regular-svg-icons';
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
  const { showTooltip, hideTooltip, toggleTooltip } = useTooltip();
  const [webhooks, setWebhooks] = useState<WebhookSettings[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<WebhookSettings | null>(null);
  const [testingWebhook, setTestingWebhook] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [formErrors, setFormErrors] = useState<{[key: string]: string}>({});
  const [formData, setFormData] = useState({
    url: '',
    name: '',
    events: [] as string[],
    secret: '',
    customHeaders: ''
  });
  const [showAdvanced, setShowAdvanced] = useState(false);

  const functions = getFunctions();
  const saveWebhookSettings = httpsCallable(functions, 'saveWebhookSettings');
  const updateWebhookSettings = httpsCallable(functions, 'updateWebhookSettings');
  const deleteWebhook = httpsCallable(functions, 'deleteWebhook');
  const testWebhook = httpsCallable(functions, 'testWebhook');

  const eventTypes = [
    { 
      value: 'website_down', 
      label: 'Website Down', 
      color: 'red',
      description: 'Triggered when a website becomes unavailable or returns error codes',
      icon: 'exclamation-triangle'
    },
    { 
      value: 'website_up', 
      label: 'Website Up', 
      color: 'green',
      description: 'Triggered when a website becomes available again after being down',
      icon: 'check-circle'
    },
    { 
      value: 'website_error', 
      label: 'Website Error', 
      color: 'yellow',
      description: 'Triggered when a website returns error codes or has performance issues',
      icon: 'exclamation-circle'
    }
  ];

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

  const validateForm = () => {
    const errors: {[key: string]: string} = {};
    
    if (!formData.name.trim()) {
      errors.name = 'Name is required';
    }
    
    if (!formData.url.trim()) {
      errors.url = 'URL is required';
    } else if (!isValidUrl(formData.url)) {
      errors.url = 'Please enter a valid HTTPS URL';
    }
    
    if (formData.events.length === 0) {
      errors.events = 'Please select at least one event type';
    }
    
    if (formData.customHeaders.trim()) {
      try {
        JSON.parse(formData.customHeaders);
      } catch {
        errors.customHeaders = 'Invalid JSON format';
      }
    }
    
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const isValidUrl = (string: string) => {
    try {
      const url = new URL(string);
      return url.protocol === 'https:';
    } catch {
      return false;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId || !validateForm()) return;

    try {
      setLoading(true);
      
      // Parse custom headers
      let headers = {};
      if (formData.customHeaders.trim()) {
        headers = JSON.parse(formData.customHeaders);
      }

      const data = {
        url: formData.url,
        name: formData.name,
        events: formData.events,
        secret: formData.secret || null,
        headers
      };

      if (editingWebhook) {
        await updateWebhookSettings({ ...data, id: editingWebhook.id });
      } else {
        await saveWebhookSettings(data);
      }

      setShowModal(false);
      setEditingWebhook(null);
      setFormData({ url: '', name: '', events: [], secret: '', customHeaders: '' });
      setFormErrors({});
    } catch (error: any) {
      setFormErrors({ submit: error.message || 'Failed to save webhook' });
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (webhook: WebhookSettings) => {
    setEditingWebhook(webhook);
    setFormData({
      url: webhook.url,
      name: webhook.name,
      events: webhook.events,
      secret: webhook.secret || '',
      customHeaders: webhook.headers ? JSON.stringify(webhook.headers, null, 2) : ''
    });
    setFormErrors({});
    setShowModal(true);
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

  const toggleEvent = (event: string) => {
    setFormData(prev => ({
      ...prev,
      events: prev.events.includes(event)
        ? prev.events.filter(e => e !== event)
        : [...prev.events, event]
    }));
    // Clear events error when user selects an event
    if (formErrors.events) {
      setFormErrors(prev => ({ ...prev, events: '' }));
    }
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingWebhook(null);
    setFormData({ url: '', name: '', events: [], secret: '', customHeaders: '' });
    setFormErrors({});
    setShowAdvanced(false);
  };

  return (
    <>
      {/* Fixed Page Header - Never overflows */}
      <div className="w-full overflow-hidden mb-6">
        {/* Title and Primary Actions */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 sm:gap-4 w-full overflow-hidden">
          <h1 className={`text-xl sm:text-2xl uppercase tracking-widest ${typography.fontFamily.display} ${theme.colors.text.primary} flex-shrink-0`}>
            Webhook Notifications
          </h1>
          <div className="flex gap-2 flex-shrink-0 w-full sm:max-w-[200px] justify-self-start sm:justify-self-end">
            <Button
              onClick={() => setShowModal(true)}
              variant="gradient"
              size="md"
              className="flex items-center gap-2 w-full justify-center cursor-pointer"
            >
              <FontAwesomeIcon icon={faPlus} className="w-3 h-3" />
              Add Webhook
            </Button>
          </div>
        </div>

        {/* Search and Quick Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 sm:gap-4 w-full mt-4 overflow-hidden">
          {/* Search Bar */}
          <div className="relative w-full sm:w-80 flex-shrink-0 min-w-0 overflow-hidden sm:max-w-[320px] justify-self-start">
            <Input
              type="text"
              placeholder="Search webhooks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              leftIcon={
                <FontAwesomeIcon icon={faSearch} className="w-4 h-4 text-neutral-300" />
              }
              rightIcon={
                searchQuery ? (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="cursor-pointer"
                  >
                    <span className="text-sm text-neutral-400 hover:text-neutral-200 transition-colors">
                      ✕
                    </span>
                  </button>
                ) : undefined
              }
            />
          </div>
        </div>

        {/* Unified Stats Display */}
        <div className="flex items-center gap-3 sm:gap-4 text-sm flex-shrink-0 min-w-0 overflow-hidden mt-8">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 overflow-hidden">
            <span className="flex items-center gap-1 flex-shrink-0">
              <FontAwesomeIcon icon={faCheckCircle} className="text-green-500" />
              <span className={`${theme.colors.text.muted} truncate`}>
                {webhooks.filter(w => w.enabled).length} active
              </span>
            </span>
            <span className="flex items-center gap-1 flex-shrink-0">
              <FontAwesomeIcon icon={faPauseCircle} className="text-yellow-500" />
              <span className={`${theme.colors.text.muted} truncate`}>
                {webhooks.filter(w => !w.enabled).length} paused
              </span>
            </span>
            <span className={`${typography.fontFamily.mono} ${theme.colors.text.muted} hidden sm:inline flex-shrink-0 truncate`}>
              {webhooks.length} total
            </span>
          </div>
        </div>
      </div>

      {/* Table Section - Can overflow independently */}
      <div className="w-full mt-6">
        {/* Webhooks List */}
        {loading ? (
          <div className="space-y-3" role="status" aria-label="Loading webhooks">
            <LoadingSkeleton type="list-item" />
            <LoadingSkeleton type="list-item" />
            <LoadingSkeleton type="list-item" />
          </div>
        ) : (
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
            onAddFirstWebhook={() => setShowModal(true)}
          />
        )}
      </div>

      {/* Info Card - Only show when no webhooks exist */}
        {webhooks.length === 0 && !loading && (
          <div className="relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-blue-500/5 to-purple-500/5" />
            <div className="relative p-4 sm:p-6 md:p-8">
              <div className="flex flex-col sm:flex-row items-start gap-4 sm:gap-6">
                <div className={`flex-shrink-0 w-12 h-12 md:w-14 md:h-14 rounded-full ${theme.colors.background.secondary} flex items-center justify-center`}>
                  <FontAwesomeIcon icon="info-circle" className={`w-6 h-6 md:w-7 md:h-7 ${theme.colors.text.primary}`} />
                </div>
                <div className="flex-1 space-y-3 sm:space-y-4 min-w-0">
                  <h3 className={`text-lg sm:text-xl md:text-2xl ${theme.colors.text.primary} font-semibold`}>
                    Test with webhook.site
                  </h3>
                  <p className={`${theme.colors.text.secondary} leading-relaxed text-sm sm:text-base md:text-lg`}>
                    Get a free test URL from{' '}
                    <a 
                      href="https://webhook.site" 
                      target="_blank" 
                      rel="noopener noreferrer" 
                      className={`${theme.colors.text.primary} hover:underline font-medium`}
                    >
                      webhook.site
                    </a>{' '}
                    to test your webhook integration before connecting your real endpoints.
                  </p>
                  <div className={`${theme.colors.background.secondary} rounded-lg p-3 sm:p-4 md:p-5 border ${theme.colors.border.primary}`}>
                    <code className={`${theme.colors.text.secondary} text-xs sm:text-sm md:text-base font-mono break-all`}>
                      https://webhook.site/your-unique-id
                    </code>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Subtle hint for existing webhooks */}
        {webhooks.length > 0 && (
          <div className={`text-xs sm:text-sm ${theme.colors.text.muted} flex items-center gap-2 sm:gap-3`}>
            <FontAwesomeIcon icon="info-circle" className="w-3 h-3 sm:w-4 sm:h-4 flex-shrink-0" />
            <span className="break-words">
              Need a test URL? Get one from{' '}
              <a 
                href="https://webhook.site" 
                target="_blank" 
                rel="noopener noreferrer" 
                className="text-blue-400 hover:underline"
              >
                webhook.site
              </a>
            </span>
          </div>
        )}

      {/* Add/Edit Webhook Modal */}
      <Modal
        isOpen={showModal}
        onClose={closeModal}
        title={editingWebhook ? 'Edit Webhook' : 'Add Webhook'}
        size="lg"
      >
        <form onSubmit={handleSubmit} className="space-y-6 sm:space-y-8">
          {/* Basic Information */}
          <div className="space-y-4 sm:space-y-6">
            <div>
              <h3 className="text-lg font-medium text-white mb-4 sm:mb-6">Basic Information</h3>
              
              <div className="space-y-4 sm:space-y-6">
                {/* Webhook Name */}
                <div>
                  <Label htmlFor="name" className="block text-sm font-medium text-gray-300 mb-2">
                    Name
                  </Label>
                  <Input
                    id="name"
                    type="text"
                    value={formData.name}
                    onChange={(e) => {
                      setFormData({ ...formData, name: e.target.value });
                      if (formErrors.name) setFormErrors(prev => ({ ...prev, name: '' }));
                    }}
                    placeholder="Slack Alerts"
                    className={`${formErrors.name ? 'border-red-500' : ''}`}
                  />
                  {formErrors.name && (
                    <p className="text-red-400 text-sm mt-2">
                      {formErrors.name}
                    </p>
                  )}
                </div>

                {/* Webhook URL */}
                <div>
                  <Label htmlFor="url" className="block text-sm font-medium text-gray-300 mb-2">
                    URL
                  </Label>
                  <Input
                    id="url"
                    type="url"
                    value={formData.url}
                    onChange={(e) => {
                      setFormData({ ...formData, url: e.target.value });
                      if (formErrors.url) setFormErrors(prev => ({ ...prev, url: '' }));
                    }}
                    placeholder="https://webhook.site/your-unique-id"
                    className={`${formErrors.url ? 'border-red-500' : ''}`}
                  />
                  {formErrors.url && (
                    <p className="text-red-400 text-sm mt-2">
                      {formErrors.url}
                    </p>
                  )}
                  <p className="text-sm text-gray-400 mt-3">
                    Only HTTPS URLs are allowed. Get a test URL from{' '}
                    <a 
                      href="https://webhook.site" 
                      target="_blank" 
                      rel="noopener noreferrer" 
                      className="text-white hover:underline"
                    >
                      webhook.site
                    </a>
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Event Types */}
          <div className="space-y-4 sm:space-y-6">
            <div>
              <h3 className="text-lg font-medium text-white mb-4 sm:mb-6">Events</h3>
              
              <div className="space-y-2 sm:space-y-3">
                {eventTypes.map((eventType) => (
                  <div
                    key={eventType.value}
                    className={`p-3 sm:p-4 rounded-lg border transition-all cursor-pointer ${
                      formData.events.includes(eventType.value)
                        ? 'border-white/30 bg-white/5'
                        : 'border-gray-700 hover:border-gray-600 hover:bg-gray-800/30'
                    }`}
                    onClick={() => toggleEvent(eventType.value)}
                  >
                    <div className="flex items-start gap-3 sm:gap-4 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.events.includes(eventType.value)}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleEvent(eventType.value);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="w-4 h-4 rounded mt-1 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 mb-1">
                          <span className="font-medium text-white truncate">
                            {eventType.label}
                          </span>
                          <span className="text-xs text-gray-400 font-mono flex-shrink-0">
                            {eventType.value}
                          </span>
                        </div>
                        <p className="text-sm text-gray-400">
                          {eventType.description}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {formErrors.events && (
                <p className="text-red-400 text-sm mt-3">
                  {formErrors.events}
                </p>
              )}
            </div>
          </div>

          {/* Advanced Settings */}
          <div className="space-y-4 sm:space-y-6">
            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center justify-between w-full text-left mb-4 sm:mb-6 group cursor-pointer"
              >
                <h3 className="text-lg font-medium text-white">Advanced</h3>
                <FontAwesomeIcon 
                  icon={showAdvanced ? "chevron-up" : "chevron-down"} 
                  className="w-4 h-4 text-gray-400 group-hover:text-white transition-colors"
                />
              </button>
              
              {showAdvanced && (
                <div className="space-y-4 sm:space-y-6 animate-in slide-in-from-top-2 duration-200">
                  {/* Secret */}
                  <div>
                    <Label htmlFor="secret" className="block text-sm font-medium text-gray-300 mb-2">
                      Secret
                      <FontAwesomeIcon 
                        icon="info-circle" 
                        className="w-3 h-3 text-gray-500 ml-2 cursor-pointer"
                        onMouseEnter={(e) => showTooltip(e, "Used to generate HMAC-SHA256 signature for request verification")}
                        onMouseLeave={hideTooltip}
                        onClick={(e) => toggleTooltip(e, "Used to generate HMAC-SHA256 signature for request verification", "secret-tooltip")}
                      />
                    </Label>
                    <Input
                      id="secret"
                      type="password"
                      value={formData.secret}
                      onChange={(e) => setFormData({ ...formData, secret: e.target.value })}
                      placeholder="Optional"
                      className=""
                    />
                    <p className="text-sm text-gray-400 mt-2">
                      Adds X-Exit1-Signature header with HMAC-SHA256 hash
                    </p>
                  </div>

                  {/* Custom Headers */}
                  <div>
                    <Label htmlFor="customHeaders" className="block text-sm font-medium text-gray-300 mb-2">
                      Custom Headers
                      <FontAwesomeIcon 
                        icon="info-circle" 
                        className="w-3 h-3 text-gray-500 ml-2 cursor-pointer"
                        onMouseEnter={(e) => showTooltip(e, "Additional HTTP headers to include with webhook requests")}
                        onMouseLeave={hideTooltip}
                        onClick={(e) => toggleTooltip(e, "Additional HTTP headers to include with webhook requests", "headers-tooltip")}
                      />
                    </Label>
                    <textarea
                      id="customHeaders"
                      value={formData.customHeaders}
                      onChange={(e) => {
                        setFormData({ ...formData, customHeaders: e.target.value });
                        if (formErrors.customHeaders) setFormErrors(prev => ({ ...prev, customHeaders: '' }));
                      }}
                      placeholder='{\n  "Authorization": "Bearer your-token"\n}'
                      className={`w-full px-3 sm:px-4 py-3 border rounded-lg bg-gradient-to-br from-black/60 to-gray-950/90 backdrop-blur-md border-gray-800/60 text-white font-mono text-sm resize-y min-h-[80px] focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 hover:bg-gradient-to-br hover:from-black/70 hover:to-gray-950/100 hover:border-gray-700/60 ${
                        formErrors.customHeaders ? 'border-red-500' : ''
                      }`}
                      rows={3}
                    />
                    {formErrors.customHeaders && (
                      <p className="text-red-400 text-sm mt-2">
                        {formErrors.customHeaders}
                      </p>
                    )}
                    <p className="text-sm text-gray-400 mt-2">
                      JSON format for additional headers
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Form Error */}
          {formErrors.submit && (
            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
              <p className="text-red-400 text-sm">
                {formErrors.submit}
              </p>
            </div>
          )}

          {/* Form Actions */}
          <div className="flex flex-col sm:flex-row gap-3 pt-4 sm:pt-6">
            <Button 
              type="submit" 
              variant="gradient"
              disabled={loading || formData.events.length === 0}
              className="flex-1 cursor-pointer"
            >
              {loading ? (
                <FontAwesomeIcon icon="spinner" spin className="w-4 h-4 mr-2" />
              ) : (
                <FontAwesomeIcon icon={editingWebhook ? "save" : "plus"} className="w-4 h-4 mr-2" />
              )}
              {editingWebhook ? 'Update' : 'Create'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={closeModal}
              className="flex-1 cursor-pointer"
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
};

export default WebhooksContent; 