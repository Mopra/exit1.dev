import { useState, useEffect, useRef } from 'react';
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
import IconButton from '../components/ui/IconButton';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { theme, typography } from '../config/theme';

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

interface WebhookActionsProps {
  webhook: WebhookSettings;
  testingWebhook: string | null;
  onTest: (id: string) => void;
  onEdit: (webhook: WebhookSettings) => void;
  onDelete: (id: string) => void;
}

const WebhookActions: React.FC<WebhookActionsProps> = ({ webhook, testingWebhook, onTest, onEdit, onDelete }) => {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setShowMenu(false);
    }
  };

  const handleTest = () => {
    onTest(webhook.id);
    setShowMenu(false);
  };

  const handleEdit = () => {
    onEdit(webhook);
    setShowMenu(false);
  };

  const handleDelete = () => {
    onDelete(webhook.id);
    setShowMenu(false);
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };

    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMenu]);

  return (
    <div className="relative" ref={menuRef}>
      <IconButton
        icon={<FontAwesomeIcon icon="ellipsis" className="w-5 h-5 cursor-pointer" />}
        variant="ghost"
        size="sm"
        onClick={() => setShowMenu(!showMenu)}
        onKeyDown={handleMenuKeyDown}
        aria-label="More options"
        aria-expanded={showMenu}
        aria-haspopup="menu"
      />
      
      {showMenu && (
        <div 
          className={`absolute right-0 top-8 ${theme.colors.background.modal} ${theme.colors.border.primary} z-10 min-w-[140px] rounded-xl`}
          role="menu"
          aria-label="Webhook actions"
        >
          <Button
            variant="ghost"
            onClick={handleTest}
            disabled={testingWebhook === webhook.id}
            role="menuitem"
            tabIndex={0}
            className={`w-full text-left px-4 py-2 ${theme.colors.background.card} focus:${theme.colors.button.primary.background} focus:text-black rounded-t-xl`}
          >
            {testingWebhook === webhook.id ? (
              <FontAwesomeIcon icon="spinner" spin className="w-4 h-4 mr-2" />
            ) : (
              <FontAwesomeIcon icon="paper-plane" className="w-4 h-4 mr-2" />
            )}
            Test
          </Button>
          <Button
            variant="ghost"
            onClick={handleEdit}
            role="menuitem"
            tabIndex={0}
            className={`w-full text-left px-4 py-2 ${theme.colors.background.card} focus:${theme.colors.button.primary.background} focus:text-black`}
          >
            <FontAwesomeIcon icon="edit" className="w-4 h-4 mr-2" />
            Edit
          </Button>
          <Button
            variant="ghost"
            onClick={handleDelete}
            role="menuitem"
            tabIndex={0}
            className={`w-full text-left px-4 py-2 ${theme.colors.background.card} focus:${theme.colors.button.primary.background} focus:text-black rounded-b-xl`}
          >
            <FontAwesomeIcon icon="trash" className="w-4 h-4 mr-2" />
            Delete
          </Button>
        </div>
      )}
    </div>
  );
};

const Notifications = () => {
  const { userId } = useAuth();
  const [webhooks, setWebhooks] = useState<WebhookSettings[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<WebhookSettings | null>(null);
  const [testingWebhook, setTestingWebhook] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
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

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedUrl(id);
      setTimeout(() => setCopiedUrl(null), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopiedUrl(id);
      setTimeout(() => setCopiedUrl(null), 2000);
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
    <div className="container mx-auto max-w-6xl px-3 sm:px-6 py-8">
      {/* Header Section */}
      <div className="mb-12">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 mb-8">
          <div>
            <h1 className={`text-4xl sm:text-5xl tracking-widest uppercase ${typography.fontFamily.display} ${theme.colors.text.primary} mb-4`}>
              Notifications
            </h1>
            <p className={`text-xl ${theme.colors.text.secondary} max-w-2xl leading-relaxed`}>
              Configure webhook notifications to receive real-time alerts when your websites change status.
            </p>
          </div>
          <div className="lg:flex-shrink-0">
            <Button 
              onClick={() => setShowModal(true)} 
              disabled={loading}
              className="w-full lg:w-auto text-lg px-8 py-3"
            >
              <FontAwesomeIcon icon="plus" className="w-5 h-5 mr-3" />
              Add Webhook
            </Button>
          </div>
        </div>
        
        {/* Info Card */}
        <Card className="relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-blue-500/5 to-purple-500/5" />
          <div className="relative p-6">
            <div className="flex items-start gap-4">
              <div className={`flex-shrink-0 w-12 h-12 rounded-full ${theme.colors.background.secondary} flex items-center justify-center`}>
                <FontAwesomeIcon icon="info-circle" className={`w-6 h-6 ${theme.colors.text.primary}`} />
              </div>
              <div className="flex-1">
                <h3 className={`text-xl ${theme.colors.text.primary} mb-3 font-semibold`}>
                  Test with webhook.site
                </h3>
                <p className={`${theme.colors.text.secondary} mb-4 leading-relaxed`}>
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
                <div className={`${theme.colors.background.secondary} rounded-lg p-4 border ${theme.colors.border.primary}`}>
                  <div className="flex items-center justify-between gap-4">
                    <code className={`${theme.colors.text.secondary} text-sm font-mono flex-1 break-all`}>
                      {getExampleUrl()}
                    </code>
                    <Tooltip content="Copy example URL">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyToClipboard(getExampleUrl(), 'example')}
                        className="flex-shrink-0"
                      >
                        <FontAwesomeIcon 
                          icon={copiedUrl === 'example' ? "check" : "copy"} 
                          className="w-4 h-4" 
                        />
                      </Button>
                    </Tooltip>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Webhooks List */}
      {loading && webhooks.length === 0 ? (
        <div className="text-center py-16">
          <div className={`inline-flex items-center gap-3 text-xl ${theme.colors.text.secondary}`}>
            <FontAwesomeIcon icon="spinner" spin className="w-6 h-6" />
            Loading webhooks...
          </div>
        </div>
      ) : webhooks.length === 0 ? (
        <Card className="text-center py-16">
          <div className={`w-24 h-24 mx-auto mb-6 rounded-full ${theme.colors.background.secondary} flex items-center justify-center`}>
            <FontAwesomeIcon icon="webhook" className={`w-12 h-12 ${theme.colors.text.secondary}`} />
          </div>
          <h3 className={`text-2xl ${theme.colors.text.primary} mb-4 font-semibold`}>No webhooks configured</h3>
          <p className={`${theme.colors.text.secondary} mb-8 max-w-md mx-auto text-lg leading-relaxed`}>
            Add your first webhook to start receiving instant notifications when your websites change status.
          </p>
          <Button onClick={() => setShowModal(true)} className="text-lg px-8 py-3">
            <FontAwesomeIcon icon="plus" className="w-5 h-5 mr-3" />
            Add Your First Webhook
          </Button>
        </Card>
      ) : (
        <div>
          <div className="flex items-center justify-between mb-6">
            <h2 className={`text-2xl ${theme.colors.text.primary} font-semibold`}>
              Your Webhooks ({webhooks.length})
            </h2>
          </div>
          
          <div className="grid gap-6">
            {webhooks.map((webhook) => (
              <Card key={webhook.id} className="group hover:shadow-lg transition-all duration-200">
                <div className="p-6">
                  <div className="flex flex-col xl:flex-row xl:items-center gap-6">
                    {/* Webhook Info */}
                    <div className="flex-1">
                      <div className="flex items-center gap-4 mb-4">
                        <h3 className={`text-xl ${theme.colors.text.primary} font-semibold`}>
                          {webhook.name}
                        </h3>
                        <Badge variant={webhook.enabled ? 'success' : 'default'} className="text-sm px-3 py-1">
                          <FontAwesomeIcon 
                            icon={webhook.enabled ? "check-circle" : "pause-circle"} 
                            className="w-3 h-3 mr-2" 
                          />
                          {webhook.enabled ? 'Active' : 'Paused'}
                        </Badge>
                        {webhook.secret && (
                          <Tooltip content="This webhook uses a secret for signature verification">
                            <Badge variant="default" className="text-sm px-3 py-1">
                              <FontAwesomeIcon icon="shield-alt" className="w-3 h-3 mr-2" />
                              Secured
                            </Badge>
                          </Tooltip>
                        )}
                      </div>
                      
                      <div className={`${theme.colors.background.secondary} rounded-lg p-4 border ${theme.colors.border.primary} mb-4`}>
                        <div className="flex items-center justify-between gap-4">
                          <code className={`${theme.colors.text.secondary} text-sm font-mono flex-1 break-all`}>
                            {webhook.url}
                          </code>
                          <Tooltip content={copiedUrl === webhook.id ? "Copied!" : "Copy URL"}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => copyToClipboard(webhook.url, webhook.id)}
                              className="flex-shrink-0"
                            >
                              <FontAwesomeIcon 
                                icon={copiedUrl === webhook.id ? "check" : "copy"} 
                                className="w-4 h-4" 
                              />
                            </Button>
                          </Tooltip>
                        </div>
                      </div>
                      
                      <div className="flex flex-wrap gap-2">
                        {webhook.events.map((event) => {
                          const eventType = eventTypes.find(et => et.value === event);
                          return (
                            <Tooltip key={event} content={eventType?.description || event}>
                              <Badge variant={eventType?.color as any || 'default'} className="text-sm px-3 py-1">
                                <FontAwesomeIcon icon={eventType?.icon as any || "bell"} className="w-3 h-3 mr-2" />
                                {eventType?.label || event}
                              </Badge>
                            </Tooltip>
                          );
                        })}
                      </div>
                    </div>
                    
                    {/* Actions */}
                    <WebhookActions 
                      webhook={webhook}
                      testingWebhook={testingWebhook}
                      onTest={handleTest}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                    />
                  </div>
                  
                  {/* Test Result */}
                  {testResult && testingWebhook === null && (
                    <div className="mt-4 pt-4 border-t border-white/10">
                      <div className={`p-4 rounded-lg ${testResult.success 
                        ? 'bg-green-500/10 border border-green-500/20' 
                        : 'bg-red-500/10 border border-red-500/20'
                      }`}>
                        <div className="flex items-center gap-3">
                          <FontAwesomeIcon 
                            icon={testResult.success ? "check-circle" : "exclamation-triangle"} 
                            className={`w-5 h-5 ${testResult.success ? 'text-green-400' : 'text-red-400'}`} 
                          />
                          <div className="flex-1">
                            <p className={`font-medium ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                              {testResult.success ? 'Test webhook sent successfully!' : 'Test failed'}
                            </p>
                            {testResult.message && (
                              <p className={`text-sm mt-1 ${theme.colors.text.secondary}`}>
                                {testResult.message}
                              </p>
                            )}
                            {testResult.statusCode && (
                              <p className={`text-sm mt-1 ${theme.colors.text.secondary}`}>
                                Status: {testResult.statusCode}
                                {testResult.responseTime && ` • Response time: ${testResult.responseTime}ms`}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

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
    </div>
  );
};

export default Notifications; 