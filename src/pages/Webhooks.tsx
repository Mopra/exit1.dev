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

import { useTooltip } from '../components/ui/Tooltip';

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





  const closeModal = () => {
    setShowModal(false);
    setEditingWebhook(null);
    setFormData({ url: '', name: '', events: [], secret: '', customHeaders: '' });
    setFormErrors({});
    setShowAdvanced(false);
  };

  return (
    <>
      {/* Notifications Section */}
      <Card className="py-4 md:py-6 mb-8 md:mb-12 border-0">
        {/* Main Header */}
        <div className="px-3 md:px-4 lg:px-6 mb-8 md:mb-6">
          <div className="flex flex-col gap-6 md:gap-4">
            {/* Title and Primary Actions */}
            <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-6 md:gap-4">
              <h1 className={`text-xl md:text-2xl uppercase tracking-widest ${typography.fontFamily.display} ${theme.colors.text.primary}`}>
                Webhook Notifications
              </h1>
              <div className="flex gap-2">
                <Button
                  onClick={() => setShowModal(true)}
                  variant="gradient"
                  size="sm"
                  className="flex items-center gap-2 w-full md:w-auto justify-center"
                >
                  <FontAwesomeIcon icon={faPlus} className="w-3 h-3" />
                  Add Webhook
                </Button>
              </div>
            </div>

            {/* Search and Quick Stats */}
            <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-6 md:gap-4">
                             {/* Unified Stats Display */}
               <div className="flex items-center gap-3 md:gap-4 text-sm">
                 <div className="flex items-center gap-2 md:gap-3">
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
                   <span className={`${typography.fontFamily.mono} ${theme.colors.text.muted} hidden md:inline`}>
                     {webhooks.length} total
                   </span>
                 </div>
               </div>

               {/* Search Bar */}
               <div className="relative w-full md:w-80">
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

                 {/* Info Card - Only show when no webhooks exist */}
         {webhooks.length === 0 && !loading && (
           <div className="px-3 md:px-4 lg:px-6 mb-12 md:mb-8">
             <Card className="relative overflow-hidden">
               <div className="absolute inset-0 bg-gradient-to-r from-blue-500/5 to-purple-500/5" />
               <div className="relative p-6 md:p-8">
                 <div className="flex items-start gap-6">
                   <div className={`flex-shrink-0 w-12 h-12 md:w-14 md:h-14 rounded-full ${theme.colors.background.secondary} flex items-center justify-center`}>
                     <FontAwesomeIcon icon="info-circle" className={`w-6 h-6 md:w-7 md:h-7 ${theme.colors.text.primary}`} />
                   </div>
                   <div className="flex-1 space-y-4">
                     <h3 className={`text-xl md:text-2xl ${theme.colors.text.primary} font-semibold`}>
                       Test with webhook.site
                     </h3>
                     <p className={`${theme.colors.text.secondary} leading-relaxed text-base md:text-lg`}>
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
                     <div className={`${theme.colors.background.secondary} rounded-lg p-4 md:p-5 border ${theme.colors.border.primary}`}>
                       <code className={`${theme.colors.text.secondary} text-sm md:text-base font-mono break-all`}>
                         https://webhook.site/your-unique-id
                       </code>
                     </div>
                   </div>
                 </div>
               </div>
             </Card>
           </div>
         )}

         {/* Subtle hint for existing webhooks */}
         {webhooks.length > 0 && (
           <div className="px-3 md:px-4 lg:px-6 mb-10 md:mb-6">
             <div className={`text-sm ${theme.colors.text.muted} flex items-center gap-3`}>
               <FontAwesomeIcon icon="info-circle" className="w-4 h-4" />
               <span>
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
           </div>
         )}

         {/* Webhooks List */}
         {loading ? (
           <div className="px-3 md:px-4 lg:px-6 space-y-4" role="status" aria-label="Loading webhooks">
             <LoadingSkeleton type="list-item" />
             <LoadingSkeleton type="list-item" />
             <LoadingSkeleton type="list-item" />
           </div>
         ) : (
           <div className="px-3 md:px-4 lg:px-6 mt-8 md:mt-0">
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
         <form onSubmit={handleSubmit} className="space-y-8">
           {/* Basic Information */}
           <div className="space-y-6">
             <div>
               <h3 className="text-lg font-medium text-white mb-6">Basic Information</h3>
               
               <div className="space-y-6">
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
           <div className="space-y-6">
             <div>
               <h3 className="text-lg font-medium text-white mb-6">Events</h3>
               
               <div className="space-y-3">
                                   {eventTypes.map((eventType) => (
                    <div
                      key={eventType.value}
                      className={`p-4 rounded-lg border transition-all cursor-pointer ${
                        formData.events.includes(eventType.value)
                          ? 'border-white/30 bg-white/5'
                          : 'border-gray-700 hover:border-gray-600 hover:bg-gray-800/30'
                      }`}
                      onClick={() => toggleEvent(eventType.value)}
                    >
                      <div className="flex items-start gap-4 cursor-pointer">
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
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-1">
                            <span className="font-medium text-white">
                              {eventType.label}
                            </span>
                            <span className="text-xs text-gray-400 font-mono">
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
            <div className="space-y-6">
              <div>
                                 <button
                   type="button"
                   onClick={() => setShowAdvanced(!showAdvanced)}
                   className="flex items-center justify-between w-full text-left mb-6 group cursor-pointer"
                 >
                  <h3 className="text-lg font-medium text-white">Advanced</h3>
                  <FontAwesomeIcon 
                    icon={showAdvanced ? "chevron-up" : "chevron-down"} 
                    className="w-4 h-4 text-gray-400 group-hover:text-white transition-colors"
                  />
                </button>
                
                {showAdvanced && (
                  <div className="space-y-6 animate-in slide-in-from-top-2 duration-200">
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
                        className={`w-full px-4 py-3 border rounded-lg bg-gradient-to-br from-black/60 to-gray-950/90 backdrop-blur-md border-gray-800/60 text-white font-mono text-sm resize-y min-h-[80px] focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 hover:bg-gradient-to-br hover:from-black/70 hover:to-gray-950/100 hover:border-gray-700/60 ${
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
           <div className="flex gap-3 pt-6">
             <Button 
               type="submit" 
               variant="gradient"
               disabled={loading || formData.events.length === 0}
               className="flex-1"
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
               className="flex-1"
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