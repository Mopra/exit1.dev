import React, { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheckCircle, faCopy, faExternalLinkAlt, faQuestionCircle } from '@fortawesome/free-solid-svg-icons';
import { Button, Badge, EmptyState } from '../ui';
import { useTooltip } from '../ui/Tooltip';
import { theme, typography } from '../../config/theme';
import { formatCreatedAt, highlightText } from '../../utils/formatters.tsx';

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
  const { showTooltip, hideTooltip } = useTooltip();
  
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







  // Card component for all screen sizes
  const WebhookCard = ({ webhook }: { webhook: WebhookSettings }) => (
    <div className="p-4 sm:p-6 rounded-xl bg-gradient-to-br from-gray-950/80 to-black/90 backdrop-blur-sm border border-gray-800/50 shadow-md hover:bg-gradient-to-br hover:from-gray-950/90 hover:to-black/95 transition-all duration-200">
      {/* Header with status and actions */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={webhook.enabled ? 'success' : 'default'} className="text-xs px-2 py-1">
            <FontAwesomeIcon 
              icon={webhook.enabled ? faCheckCircle : "pause-circle"} 
              className="w-3 h-3 mr-1" 
            />
            {webhook.enabled ? 'Active' : 'Paused'}
          </Badge>
          {webhook.secret && (
            <Badge 
              variant="default" 
              className="text-xs px-2 py-1 cursor-help"
              onMouseEnter={(e) => showTooltip(e, "This webhook uses a secret for signature verification")}
              onMouseLeave={hideTooltip}
            >
              <FontAwesomeIcon icon="shield-alt" className="w-3 h-3 mr-1" />
              Secured
            </Badge>
          )}
        </div>
        
        {/* Actions */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onTest(webhook.id)}
            disabled={testingWebhook === webhook.id}
            className="p-2"
            title="Test webhook"
          >
            <FontAwesomeIcon 
              icon={testingWebhook === webhook.id ? "spinner" : "paper-plane"} 
              className={`w-3 h-3 ${testingWebhook === webhook.id ? 'animate-spin' : ''}`} 
            />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onEdit(webhook)}
            className="p-2"
            title="Edit webhook"
          >
            <FontAwesomeIcon icon="edit" className="w-3 h-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(webhook.id)}
            className="p-2 text-red-500 hover:text-red-400"
            title="Delete webhook"
          >
            <FontAwesomeIcon icon="trash" className="w-3 h-3" />
          </Button>
        </div>
      </div>

      {/* Name */}
      <div className="mb-3">
        <h3 className={`font-medium ${typography.fontFamily.sans} ${theme.colors.text.primary} text-base`}>
          {highlightText(webhook.name, searchQuery)}
        </h3>
      </div>

      {/* URL */}
      <div className={`${theme.colors.background.primary} rounded-lg p-3 border ${theme.colors.border.primary} mb-3`}>
        <div className="flex items-center justify-between gap-2">
          <code className={`${theme.colors.text.secondary} text-xs font-mono flex-1 break-all`}>
            {highlightText(webhook.url, searchQuery)}
          </code>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copyToClipboard(webhook.url, webhook.id)}
              className="p-1"
              title={copiedUrl === webhook.id ? "Copied!" : "Copy URL"}
            >
              <FontAwesomeIcon 
                icon={copiedUrl === webhook.id ? "check" : faCopy} 
                className="w-3 h-3" 
              />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open(webhook.url, '_blank')}
              className="p-1"
              title="Open URL"
            >
              <FontAwesomeIcon icon={faExternalLinkAlt} className="w-3 h-3" />
            </Button>
          </div>
        </div>
      </div>

      {/* Events */}
      <div className="mb-3">
        <div className="flex flex-wrap gap-2">
          {webhook.events.map((event) => {
            const eventType = eventTypes.find(et => et.value === event);
            return (
              <Badge 
                key={event}
                variant={eventType?.color as any || 'default'} 
                className="text-xs px-2 py-1 cursor-help"
                onMouseEnter={(e) => showTooltip(e, eventType?.description || event)}
                onMouseLeave={hideTooltip}
              >
                <FontAwesomeIcon icon={eventType?.icon as any || "bell"} className="w-3 h-3 mr-1" />
                {eventType?.label || event}
              </Badge>
            );
          })}
        </div>
      </div>

                           {/* Created date */}
        <div className={`text-xs ${typography.fontFamily.mono} ${theme.colors.text.muted}`}>
          Created {formatCreatedAt(webhook.createdAt)}
        </div>
      </div>
    );

  return (
    <div className="space-y-6">
      {/* Cards Layout for All Screen Sizes */}
      <div className="space-y-4">
        {webhooks.length === 0 ? (
          <div className="text-center py-8">
            {searchQuery ? (
              <EmptyState
                variant="search"
                title="No webhooks found"
                description={`No webhooks match your search for "${searchQuery}". Try adjusting your search terms.`}
              />
            ) : (
              <EmptyState
                variant="empty"
                icon={faQuestionCircle}
                title="No webhooks configured"
                description="Add your first webhook to start receiving instant notifications when your websites change status."
                action={onAddFirstWebhook ? {
                  label: 'Add Your First Webhook',
                  onClick: onAddFirstWebhook,
                  icon: "plus"
                } : undefined}
              />
            )}
          </div>
        ) : (
          webhooks.map((webhook) => (
            <WebhookCard key={webhook.id} webhook={webhook} />
          ))
        )}
      </div>

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

    </div>
  );
};

export default WebhookTable; 