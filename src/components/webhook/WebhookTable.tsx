import React, { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { 
  faCheckCircle, 
  faPauseCircle, 
  faShieldAlt, 
  faBell,
  faExternalLinkAlt,
  faPaperPlane,
  faWebhook
} from '@fortawesome/pro-regular-svg-icons';
import { Badge, Button } from '../ui';
import DataTable, { type DataTableColumn, type DataTableAction } from '../ui/DataTable';
import { theme, typography } from '../../config/theme';

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

interface WebhookTableProps {
  webhooks: WebhookSettings[];
  onEdit: (webhook: WebhookSettings) => void;
  onDelete: (id: string) => void;
  onTest: (id: string) => void;
  testingWebhook: string | null;
  testResult: TestResult | null;
  searchQuery?: string;
  onAddFirstWebhook?: () => void;
}

const WebhookTable: React.FC<WebhookTableProps> = ({
  webhooks,
  onEdit,
  onDelete,
  onTest,
  testingWebhook,
  testResult,
  searchQuery = '',
  onAddFirstWebhook
}) => {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  
  // Portal-based tooltip state
  const [tooltipState, setTooltipState] = useState<{
    show: boolean;
    content: string;
    x: number;
    y: number;
    position: 'top' | 'bottom';
  }>({
    show: false,
    content: '',
    x: 0,
    y: 0,
    position: 'top'
  });

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

  // Portal-based tooltip handlers
  const showTooltip = useCallback((event: React.MouseEvent, content: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const tooltipHeight = 80; // Approximate tooltip height
    const gap = 8;
    
    let position: 'top' | 'bottom' = 'bottom';
    if (rect.bottom + tooltipHeight + gap > viewportHeight) {
      position = 'top';
    }
    
    setTooltipState({
      show: true,
      content,
      x: rect.left + rect.width / 2,
      y: position === 'bottom' ? rect.bottom + gap : rect.top - gap,
      position
    });
  }, []);

  const hideTooltip = useCallback(() => {
    setTooltipState(prev => ({ ...prev, show: false }));
  }, []);

  const formatCreatedAt = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  const highlightText = (text: string, query: string) => {
    if (!query.trim()) return text;
    
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    
    return parts.map((part, index) => 
      regex.test(part) ? (
        <mark key={index} className="bg-yellow-200 text-black px-1 rounded">
          {part}
        </mark>
      ) : part
    );
  };

  const columns: DataTableColumn<WebhookSettings>[] = [
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      sortKey: 'enabled',
      render: (webhook) => (
        <div className="flex items-center gap-2">
          <Badge variant={webhook.enabled ? 'success' : 'default'} className="text-xs sm:text-sm px-2 sm:px-3 py-1">
            <FontAwesomeIcon 
              icon={webhook.enabled ? faCheckCircle : faPauseCircle} 
              className="w-3 h-3 mr-1 sm:mr-2" 
            />
            {webhook.enabled ? 'Active' : 'Paused'}
          </Badge>
          {webhook.secret && (
            <Badge 
              variant="default" 
              className="text-xs sm:text-sm px-2 sm:px-3 py-1 cursor-help"
              onMouseEnter={(e) => showTooltip(e, "This webhook uses a secret for signature verification")}
              onMouseLeave={hideTooltip}
            >
              <FontAwesomeIcon icon={faShieldAlt} className="w-3 h-3 mr-1 sm:mr-2" />
              Secured
            </Badge>
          )}
        </div>
      )
    },
    {
      key: 'name',
      header: 'Name & URL',
      sortable: true,
      sortKey: 'name',
      render: (webhook) => (
        <div className="flex flex-col">
          <div className={`font-medium ${typography.fontFamily.sans} ${theme.colors.text.primary}`}>
            {highlightText(webhook.name, searchQuery)}
          </div>
          <div className={`${theme.colors.background.secondary} rounded-lg p-2 sm:p-3 border ${theme.colors.border.primary} mt-2`}>
            <div className="flex items-center justify-between gap-2 sm:gap-3">
              <code className={`${theme.colors.text.secondary} text-xs sm:text-sm font-mono flex-1 break-all`}>
                {highlightText(webhook.url, searchQuery)}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyToClipboard(webhook.url, webhook.id)}
                className="flex-shrink-0"
                onMouseEnter={(e) => showTooltip(e, copiedUrl === webhook.id ? "Copied!" : "Copy URL")}
                onMouseLeave={hideTooltip}
              >
                <FontAwesomeIcon 
                  icon={copiedUrl === webhook.id ? "check" : "copy"} 
                  className="w-3 h-3 sm:w-4 sm:h-4" 
                />
              </Button>
            </div>
          </div>
        </div>
      )
    },
    {
      key: 'events',
      header: 'Events',
      render: (webhook) => (
        <div className="flex flex-wrap gap-2">
          {webhook.events.map((event) => {
            const eventType = eventTypes.find(et => et.value === event);
            return (
              <Badge 
                key={event}
                variant={eventType?.color as any || 'default'} 
                className="text-xs sm:text-sm px-2 sm:px-3 py-1 cursor-help"
                onMouseEnter={(e) => showTooltip(e, eventType?.description || event)}
                onMouseLeave={hideTooltip}
              >
                <FontAwesomeIcon icon={eventType?.icon as any || faBell} className="w-3 h-3 mr-1 sm:mr-2" />
                {eventType?.label || event}
              </Badge>
            );
          })}
        </div>
      )
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortable: true,
      sortKey: 'createdAt',
      hidden: true, // Hidden on mobile
      render: (webhook) => (
        <div className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.muted}`}>
          {formatCreatedAt(webhook.createdAt)}
        </div>
      )
    }
  ];

  const actions: DataTableAction<WebhookSettings>[] = [
    {
      key: 'test',
      label: 'Test',
      icon: faPaperPlane,
      onClick: (webhook) => onTest(webhook.id),
      disabled: (webhook) => testingWebhook === webhook.id,
      className: testingWebhook ? 'opacity-50 cursor-not-allowed' : ''
    },
    {
      key: 'open',
      label: 'Open URL',
      icon: faExternalLinkAlt,
      onClick: (webhook) => window.open(webhook.url, '_blank')
    }
  ];

  const emptyState = {
    icon: faWebhook,
    title: 'No webhooks configured',
    description: 'Add your first webhook to start receiving instant notifications when your websites change status.',
    action: onAddFirstWebhook ? {
      label: 'Add Your First Webhook',
      onClick: onAddFirstWebhook
    } : undefined
  };

  return (
    <div className="space-y-6">
      <DataTable
        data={webhooks}
        columns={columns}
        actions={actions}
        onEdit={onEdit}
        onDelete={(webhook) => onDelete(webhook.id)}
        searchQuery={searchQuery}
        emptyState={emptyState}
        getItemId={(webhook) => webhook.id}
        getItemName={(webhook) => webhook.name}
        isItemDisabled={(webhook) => !webhook.enabled}
        highlightText={highlightText}
      />

      {/* Test Result Display */}
      {testResult && testingWebhook === null && (
        <div className={`p-4 sm:p-6 rounded-lg border ${testResult.success 
          ? 'bg-green-500/10 border-green-500/20' 
          : 'bg-red-500/10 border-red-500/20'
        }`}>
          <div className="flex items-center gap-3">
            <FontAwesomeIcon 
              icon={testResult.success ? faCheckCircle : "exclamation-triangle"} 
              className={`w-4 h-4 sm:w-5 sm:h-5 ${testResult.success ? 'text-green-400' : 'text-red-400'}`} 
            />
            <div className="flex-1">
              <p className={`font-medium text-sm sm:text-base ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                {testResult.success ? 'Test webhook sent successfully!' : 'Test failed'}
              </p>
              {testResult.message && (
                <p className={`text-xs sm:text-sm mt-1 ${theme.colors.text.secondary}`}>
                  {testResult.message}
                </p>
              )}
              {testResult.statusCode && (
                <p className={`text-xs sm:text-sm mt-1 ${theme.colors.text.secondary}`}>
                  Status: {testResult.statusCode}
                  {testResult.responseTime && ` • Response time: ${testResult.responseTime}ms`}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Portal-based Tooltip */}
      {tooltipState.show && createPortal(
        <div
          className={`fixed z-[60] px-3 py-2 text-sm bg-gray-900 text-white rounded-lg shadow-lg max-w-xs pointer-events-none ${typography.fontFamily.mono}`}
          style={{
            left: `${tooltipState.x}px`,
            top: `${tooltipState.y}px`,
            transform: `translateX(-50%) ${tooltipState.position === 'top' ? 'translateY(-100%)' : ''}`,
          }}
        >
          <div className="whitespace-pre-line">
            {tooltipState.content}
          </div>
          {/* Arrow */}
          <div
            className={`absolute w-2 h-2 bg-gray-900 transform rotate-45 ${
              tooltipState.position === 'top' 
                ? 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2' 
                : 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2'
            }`}
          />
        </div>,
        document.body
      )}
    </div>
  );
};

export default WebhookTable; 