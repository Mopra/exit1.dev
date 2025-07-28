import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { collection, query, where, onSnapshot, orderBy } from 'firebase/firestore';
import { db } from '../firebase';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Label from '../components/ui/Label';
import Modal from '../components/ui/Modal';
import Badge from '../components/ui/Badge';
import Tooltip from '../components/ui/Tooltip';
import Divider from '../components/ui/Divider';

import LoadingSkeleton from '../components/layout/LoadingSkeleton';
import WebhookTable from '../components/webhook/WebhookTable';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { theme, typography } from '../config/theme';
import { faPlus, faSearch, faCheckCircle, faPauseCircle } from '@fortawesome/pro-regular-svg-icons';

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



const Webhooks = () => {
  const { userId } = useAuth();
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

  useEffect(() => {
    if (!userId) return;

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

    return () => unsubscribe();
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
    if (!confirm('Are you sure you want to delete this webhook? This action cannot be undone.')) return;

    try {
      await deleteWebhook({ id });
    } catch (error: any) {
      alert(error.message || 'Failed to delete webhook');
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



  const getExampleUrl = () => {
    return 'https://webhook.site/your-unique-id';
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingWebhook(null);
    setFormData({ url: '', name: '', events: [], secret: '', customHeaders: '' });
    setFormErrors({});
  };

  return (
    <>
      {/* Notifications Section */}
      <Card className="py-4 sm:py-6 mb-8 sm:mb-12 border-0">
        {/* Main Header */}
        <div className="px-3 sm:px-4 lg:px-6 mb-4 sm:mb-6">
          <div className="flex flex-col gap-3 sm:gap-4">
            {/* Title and Primary Actions */}
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 sm:gap-4">
              <h1 className={`text-xl sm:text-2xl uppercase tracking-widest ${typography.fontFamily.display} ${theme.colors.text.primary}`}>
                Webhook Notifications
              </h1>
              <div className="flex gap-2">
                <Button
                  onClick={() => setShowModal(true)}
                  variant="primary"
                  size="sm"
                  className="flex items-center gap-2 w-full sm:w-auto justify-center"
                >
                  <FontAwesomeIcon icon={faPlus} className="w-3 h-3" />
                  Add Webhook
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
                      {webhooks.filter(w => w.enabled).length} active
                    </span>
                  </span>
                  <span className="flex items-center gap-1">
                    <FontAwesomeIcon icon={faPauseCircle} className="text-yellow-500" />
                    <span className={theme.colors.text.muted}>
                      {webhooks.filter(w => !w.enabled).length} paused
                    </span>
                  </span>
                  <span className={`${typography.fontFamily.mono} ${theme.colors.text.muted} hidden sm:inline`}>
                    {webhooks.length} total
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
                  placeholder="Search webhooks..."
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

        {/* Info Card */}
        <div className="px-3 sm:px-4 lg:px-6 mb-6">
          <Card className="relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-blue-500/5 to-purple-500/5" />
            <div className="relative p-4 sm:p-6">
              <div className="flex items-start gap-4">
                <div className={`flex-shrink-0 w-10 h-10 sm:w-12 sm:h-12 rounded-full ${theme.colors.background.secondary} flex items-center justify-center`}>
                  <FontAwesomeIcon icon="info-circle" className={`w-5 h-5 sm:w-6 sm:h-6 ${theme.colors.text.primary}`} />
                </div>
                <div className="flex-1">
                  <h3 className={`text-lg sm:text-xl ${theme.colors.text.primary} mb-2 sm:mb-3 font-semibold`}>
                    Test with webhook.site
                  </h3>
                  <p className={`${theme.colors.text.secondary} mb-3 sm:mb-4 leading-relaxed text-sm sm:text-base`}>
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
                  <div className={`${theme.colors.background.secondary} rounded-lg p-3 sm:p-4 border ${theme.colors.border.primary}`}>
                    <code className={`${theme.colors.text.secondary} text-xs sm:text-sm font-mono break-all`}>
                      https://webhook.site/your-unique-id
                    </code>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Webhooks List */}
        {loading ? (
          <div className="px-3 sm:px-4 lg:px-6" role="status" aria-label="Loading webhooks">
            <LoadingSkeleton type="list-item" />
            <LoadingSkeleton type="list-item" />
            <LoadingSkeleton type="list-item" />
          </div>
        ) : (
          <div className="px-3 sm:px-4 lg:px-6">
            <WebhookTable
              webhooks={filteredWebhooks()}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onTest={handleTest}
              testingWebhook={testingWebhook}
              testResult={testResult}
              searchQuery={searchQuery}
              onAddFirstWebhook={() => setShowModal(true)}
            />
          </div>
        )}
      </Card>

      {/* Add/Edit Webhook Modal */}
      <Modal
        isOpen={showModal}
        onClose={closeModal}
        title={editingWebhook ? 'Edit Webhook' : 'Add Webhook'}
        size="lg"
      >
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Webhook Name */}
          <div>
            <Label htmlFor="name" className="flex items-center gap-2 mb-2">
              <FontAwesomeIcon icon="tag" className="w-4 h-4" />
              Webhook Name
            </Label>
            <Input
              id="name"
              type="text"
              value={formData.name}
              onChange={(e) => {
                setFormData({ ...formData, name: e.target.value });
                if (formErrors.name) setFormErrors(prev => ({ ...prev, name: '' }));
              }}
              placeholder="e.g., Slack Alerts, Discord Bot, Email Service"
              className={formErrors.name ? 'border-red-500' : ''}
            />
            {formErrors.name && (
              <p className="text-red-400 text-sm mt-1 flex items-center gap-2">
                <FontAwesomeIcon icon="exclamation-triangle" className="w-3 h-3" />
                {formErrors.name}
              </p>
            )}
          </div>

          {/* Webhook URL */}
          <div>
            <Label htmlFor="url" className="flex items-center gap-2 mb-2">
              <FontAwesomeIcon icon="link" className="w-4 h-4" />
              Webhook URL
            </Label>
            <Input
              id="url"
              type="url"
              value={formData.url}
              onChange={(e) => {
                setFormData({ ...formData, url: e.target.value });
                if (formErrors.url) setFormErrors(prev => ({ ...prev, url: '' }));
              }}
              placeholder={getExampleUrl()}
              className={formErrors.url ? 'border-red-500' : ''}
            />
            {formErrors.url && (
              <p className="text-red-400 text-sm mt-1 flex items-center gap-2">
                <FontAwesomeIcon icon="exclamation-triangle" className="w-3 h-3" />
                {formErrors.url}
              </p>
            )}
            <p className={`text-sm ${theme.colors.text.secondary} mt-2 flex items-center gap-2`}>
              <FontAwesomeIcon icon="shield-alt" className="w-3 h-3" />
              Only HTTPS URLs are allowed for security. Get a test URL from{' '}
              <a 
                href="https://webhook.site" 
                target="_blank" 
                rel="noopener noreferrer" 
                className={`${theme.colors.text.primary} hover:underline`}
              >
                webhook.site
              </a>
            </p>
          </div>

          {/* Event Types */}
          <div>
            <Label className="flex items-center gap-2 mb-3">
              <FontAwesomeIcon icon="bell" className="w-4 h-4" />
              Events to Listen For
            </Label>
            <div className="grid gap-3">
              {eventTypes.map((eventType) => (
                <div
                  key={eventType.value}
                  className={`p-4 rounded-lg border transition-all cursor-pointer ${
                    formData.events.includes(eventType.value)
                      ? 'border-white/30 bg-white/5'
                      : 'border-white/10 hover:border-white/20 hover:bg-white/2'
                  }`}
                  onClick={() => toggleEvent(eventType.value)}
                >
                  <label className="flex items-center gap-4 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.events.includes(eventType.value)}
                      onChange={() => toggleEvent(eventType.value)}
                      className="w-4 h-4 rounded"
                    />
                    <div className="flex items-center gap-3 flex-1">
                      <FontAwesomeIcon icon={eventType.icon as any} className="w-4 h-4" />
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-1">
                          <span className={`font-medium ${theme.colors.text.primary}`}>
                            {eventType.label}
                          </span>
                          <Badge variant={eventType.color as any} className="text-xs px-2 py-1">
                            {eventType.value}
                          </Badge>
                        </div>
                        <p className={`text-sm ${theme.colors.text.secondary}`}>
                          {eventType.description}
                        </p>
                      </div>
                    </div>
                  </label>
                </div>
              ))}
            </div>
            {formErrors.events && (
              <p className="text-red-400 text-sm mt-2 flex items-center gap-2">
                <FontAwesomeIcon icon="exclamation-triangle" className="w-3 h-3" />
                {formErrors.events}
              </p>
            )}
          </div>

          <Divider />

          {/* Advanced Settings */}
          <div>
            <h3 className={`text-lg ${theme.colors.text.primary} mb-4 flex items-center gap-2`}>
              <FontAwesomeIcon icon="cogs" className="w-4 h-4" />
              Advanced Settings
            </h3>
            
            {/* Secret */}
            <div className="mb-6">
              <Label htmlFor="secret" className="flex items-center gap-2 mb-2">
                <FontAwesomeIcon icon="key" className="w-4 h-4" />
                Webhook Secret
                <Tooltip content="Used to generate HMAC-SHA256 signature for request verification">
                  <FontAwesomeIcon icon="info-circle" className={`w-3 h-3 ${theme.colors.text.secondary}`} />
                </Tooltip>
              </Label>
              <Input
                id="secret"
                type="password"
                value={formData.secret}
                onChange={(e) => setFormData({ ...formData, secret: e.target.value })}
                placeholder="Optional: Enter a secret for webhook signature"
              />
              <p className={`text-sm ${theme.colors.text.secondary} mt-2`}>
                When provided, we'll add an X-Exit1-Signature header with HMAC-SHA256 hash
              </p>
            </div>

            {/* Custom Headers */}
            <div>
              <Label htmlFor="customHeaders" className="flex items-center gap-2 mb-2">
                <FontAwesomeIcon icon="code" className="w-4 h-4" />
                Custom Headers
                <Tooltip content="Additional HTTP headers to include with webhook requests">
                  <FontAwesomeIcon icon="info-circle" className={`w-3 h-3 ${theme.colors.text.secondary}`} />
                </Tooltip>
              </Label>
              <textarea
                id="customHeaders"
                value={formData.customHeaders}
                onChange={(e) => {
                  setFormData({ ...formData, customHeaders: e.target.value });
                  if (formErrors.customHeaders) setFormErrors(prev => ({ ...prev, customHeaders: '' }));
                }}
                placeholder='{\n  "Authorization": "Bearer your-token",\n  "X-Custom-Header": "value"\n}'
                className={`w-full px-4 py-3 border rounded-lg ${theme.colors.background.primary} ${theme.colors.text.primary} font-mono text-sm resize-y min-h-[120px] ${
                  formErrors.customHeaders ? 'border-red-500' : theme.colors.border.primary
                }`}
                rows={6}
              />
              {formErrors.customHeaders && (
                <p className="text-red-400 text-sm mt-1 flex items-center gap-2">
                  <FontAwesomeIcon icon="exclamation-triangle" className="w-3 h-3" />
                  {formErrors.customHeaders}
                </p>
              )}
              <p className={`text-sm ${theme.colors.text.secondary} mt-2`}>
                JSON format for additional HTTP headers to include with requests
              </p>
            </div>
          </div>

          {/* Form Error */}
          {formErrors.submit && (
            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
              <p className="text-red-400 flex items-center gap-2">
                <FontAwesomeIcon icon="exclamation-triangle" className="w-4 h-4" />
                {formErrors.submit}
              </p>
            </div>
          )}

          {/* Form Actions */}
          <div className="flex gap-4 pt-4">
            <Button 
              type="submit" 
              disabled={loading || formData.events.length === 0}
              className="flex-1 sm:flex-none"
            >
              {loading ? (
                <FontAwesomeIcon icon="spinner" spin className="w-4 h-4 mr-2" />
              ) : (
                <FontAwesomeIcon icon={editingWebhook ? "save" : "plus"} className="w-4 h-4 mr-2" />
              )}
              {editingWebhook ? 'Update Webhook' : 'Add Webhook'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={closeModal}
              className="flex-1 sm:flex-none"
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
};

export default Webhooks; 