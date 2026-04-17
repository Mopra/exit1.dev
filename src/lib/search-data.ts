import type { LucideIcon } from 'lucide-react';
import {
  Globe,
  BarChart3,
  Activity,
  Webhook,
  Mail,
  MessageSquare,
  FileBadge,
  Database,
  Code,
  Shield,
  Users,
  Bell,
  CreditCard,
  User,
  Rocket,
  Key,
  Plug,
  AlertTriangle,
  FileText,
  Plus,
} from 'lucide-react';

// --- Types ---

export type IconName =
  | 'Globe' | 'BarChart3' | 'Activity' | 'Webhook' | 'Mail'
  | 'MessageSquare' | 'FileBadge' | 'Database' | 'Code' | 'Shield'
  | 'Users' | 'Bell' | 'CreditCard' | 'User' | 'Rocket'
  | 'Key' | 'Plug' | 'AlertTriangle' | 'FileText' | 'Plus';

/** Map from serializable icon name to Lucide component — used to restore icons from localStorage */
export const iconMap: Record<IconName, LucideIcon> = {
  Globe, BarChart3, Activity, Webhook, Mail,
  MessageSquare, FileBadge, Database, Code, Shield,
  Users, Bell, CreditCard, User, Rocket,
  Key, Plug, AlertTriangle, FileText, Plus,
};

export interface SearchItem {
  id: string;
  name: string;
  /** Additional text shown below the name */
  description?: string;
  path: string;
  /** Serializable icon name — resolve via iconMap */
  iconName: IconName;
  /** Extra terms that match but aren't displayed */
  keywords: string[];
  category: 'page' | 'check' | 'doc' | 'recent' | 'action';
  /** true = opens in new tab */
  external?: boolean;
  /** true = only visible to admins */
  adminOnly?: boolean;
  /** true = only visible to nano/scale users */
  paidOnly?: boolean;
  /** Intent string passed via navigation state — target page reads it and opens the matching dialog */
  actionIntent?: 'create-check' | 'create-status-page' | 'create-api-key';
}

// --- Quick actions ---

export const actionItems: SearchItem[] = [
  {
    id: 'action-create-check',
    name: 'Add check',
    description: 'Start monitoring a new URL or endpoint',
    path: '/checks',
    iconName: 'Plus',
    keywords: ['new', 'create', 'monitor', 'website', 'url', 'http'],
    category: 'action',
    actionIntent: 'create-check',
  },
  {
    id: 'action-create-status-page',
    name: 'Create status page',
    description: 'Publish a public or private status page',
    path: '/status',
    iconName: 'Plus',
    keywords: ['new', 'status', 'public', 'incident', 'page'],
    category: 'action',
    actionIntent: 'create-status-page',
  },
  {
    id: 'action-create-api-key',
    name: 'New API key',
    description: 'Generate an API key for programmatic access',
    path: '/api-keys',
    iconName: 'Plus',
    keywords: ['new', 'api', 'key', 'token', 'generate'],
    category: 'action',
    actionIntent: 'create-api-key',
  },
];

// --- Pages ---

export const pageItems: SearchItem[] = [
  {
    id: 'page-checks',
    name: 'Checks',
    description: 'Monitor uptime for your websites and APIs',
    path: '/checks',
    iconName: 'Globe',
    keywords: ['monitors', 'uptime', 'websites', 'http', 'ping', 'dashboard'],
    category: 'page',
  },
  {
    id: 'page-reports',
    name: 'Reports',
    description: 'Uptime reports and analytics',
    path: '/reports',
    iconName: 'BarChart3',
    keywords: ['analytics', 'uptime', 'statistics', 'charts'],
    category: 'page',
  },
  {
    id: 'page-status',
    name: 'Status',
    description: 'Public status pages',
    path: '/status',
    iconName: 'Activity',
    keywords: ['status page', 'public', 'incident'],
    category: 'page',
  },
  {
    id: 'page-webhooks',
    name: 'Webhooks',
    description: 'Webhook notification settings',
    path: '/webhooks',
    iconName: 'Webhook',
    keywords: ['notifications', 'hooks', 'endpoint'],
    category: 'page',
  },
  {
    id: 'page-emails',
    name: 'Emails',
    description: 'Email notification settings',
    path: '/emails',
    iconName: 'Mail',
    keywords: ['notifications', 'email', 'alerts'],
    category: 'page',
  },
  {
    id: 'page-sms',
    name: 'SMS',
    description: 'SMS notification settings',
    path: '/sms',
    iconName: 'MessageSquare',
    keywords: ['notifications', 'text', 'phone', 'twilio'],
    category: 'page',
    paidOnly: true,
  },
  {
    id: 'page-domain-intel',
    name: 'Domain Intelligence',
    description: 'Domain and DNS analysis tools',
    path: '/domain-intelligence',
    iconName: 'FileBadge',
    keywords: ['dns', 'domain', 'whois', 'ssl', 'certificate', 'expiry'],
    category: 'page',
  },
  {
    id: 'page-logs',
    name: 'Logs',
    description: 'BigQuery check logs',
    path: '/logs',
    iconName: 'Database',
    keywords: ['bigquery', 'history', 'log', 'query'],
    category: 'page',
  },
  {
    id: 'page-api',
    name: 'API Keys',
    description: 'Manage API keys',
    path: '/api-keys',
    iconName: 'Code',
    keywords: ['api', 'keys', 'token', 'developer'],
    category: 'page',
  },
  {
    id: 'page-billing',
    name: 'Billing',
    description: 'Manage your subscription and plan',
    path: '/billing',
    iconName: 'CreditCard',
    keywords: ['upgrade', 'plan', 'subscription', 'payment', 'nano', 'scale', 'pricing'],
    category: 'page',
  },
  {
    id: 'page-profile',
    name: 'Profile',
    description: 'Account settings',
    path: '/profile',
    iconName: 'User',
    keywords: ['account', 'settings', 'user', 'preferences'],
    category: 'page',
  },
  // Admin pages
  {
    id: 'page-admin',
    name: 'Admin Dashboard',
    description: 'System administration',
    path: '/admin',
    iconName: 'Shield',
    keywords: ['admin', 'system', 'dashboard'],
    category: 'page',
    adminOnly: true,
  },
  {
    id: 'page-admin-notifications',
    name: 'System Notifications',
    description: 'Manage system-wide notifications',
    path: '/admin/notifications',
    iconName: 'Bell',
    keywords: ['admin', 'notifications', 'system', 'alerts'],
    category: 'page',
    adminOnly: true,
  },
  {
    id: 'page-user-admin',
    name: 'User Admin',
    description: 'Manage users',
    path: '/user-admin',
    iconName: 'Users',
    keywords: ['admin', 'users', 'management'],
    category: 'page',
    adminOnly: true,
  },
  {
    id: 'page-badge-analytics',
    name: 'Badge Analytics',
    description: 'Badge usage analytics',
    path: '/admin/badges',
    iconName: 'Activity',
    keywords: ['admin', 'badges', 'analytics'],
    category: 'page',
    adminOnly: true,
  },
];

// --- Docs ---

export const docItems: SearchItem[] = [
  {
    id: 'doc-getting-started',
    name: 'Getting Started',
    description: 'Quick start guide',
    path: 'https://docs.exit1.dev/getting-started',
    iconName: 'Rocket',
    keywords: ['setup', 'onboarding', 'tutorial', 'guide', 'start'],
    category: 'doc',
    external: true,
  },
  {
    id: 'doc-monitoring',
    name: 'Monitoring',
    description: 'How monitoring works',
    path: 'https://docs.exit1.dev/monitoring',
    iconName: 'Globe',
    keywords: ['checks', 'http', 'tcp', 'ping', 'uptime', 'monitor'],
    category: 'doc',
    external: true,
  },
  {
    id: 'doc-alerting',
    name: 'Alerting',
    description: 'Alert configuration and channels',
    path: 'https://docs.exit1.dev/alerting',
    iconName: 'AlertTriangle',
    keywords: ['alerts', 'notifications', 'email', 'sms', 'webhook', 'slack', 'discord'],
    category: 'doc',
    external: true,
  },
  {
    id: 'doc-domain-intelligence',
    name: 'Domain Intelligence',
    description: 'DNS, SSL, and domain monitoring docs',
    path: 'https://docs.exit1.dev/domain-intelligence',
    iconName: 'FileBadge',
    keywords: ['dns', 'ssl', 'certificate', 'domain', 'whois'],
    category: 'doc',
    external: true,
  },
  {
    id: 'doc-integrations',
    name: 'Integrations',
    description: 'Slack, Discord, Teams, and more',
    path: 'https://docs.exit1.dev/integrations',
    iconName: 'Plug',
    keywords: ['slack', 'discord', 'teams', 'integration', 'webhook'],
    category: 'doc',
    external: true,
  },
  {
    id: 'doc-status-pages',
    name: 'Status Pages',
    description: 'Public status page setup',
    path: 'https://docs.exit1.dev/status-pages',
    iconName: 'Activity',
    keywords: ['status', 'public', 'page', 'incident'],
    category: 'doc',
    external: true,
  },
  {
    id: 'doc-billing',
    name: 'Billing & Plans',
    description: 'Plans, limits, and billing',
    path: 'https://docs.exit1.dev/billing',
    iconName: 'CreditCard',
    keywords: ['billing', 'plan', 'pricing', 'upgrade', 'nano', 'scale', 'free'],
    category: 'doc',
    external: true,
  },
  {
    id: 'doc-api-reference',
    name: 'API Reference',
    description: 'REST API documentation',
    path: 'https://docs.exit1.dev/api-reference',
    iconName: 'Code',
    keywords: ['api', 'rest', 'endpoint', 'authentication', 'rate limit'],
    category: 'doc',
    external: true,
  },
  {
    id: 'doc-api-auth',
    name: 'API Authentication',
    description: 'API key authentication guide',
    path: 'https://docs.exit1.dev/api-reference/authentication',
    iconName: 'Key',
    keywords: ['api', 'key', 'auth', 'token', 'bearer'],
    category: 'doc',
    external: true,
  },
  {
    id: 'doc-api-checks',
    name: 'API: Checks',
    description: 'CRUD operations for checks',
    path: 'https://docs.exit1.dev/api-reference/checks',
    iconName: 'FileText',
    keywords: ['api', 'checks', 'create', 'update', 'delete', 'list'],
    category: 'doc',
    external: true,
  },
];

// --- Fuse.js config ---

export const fuseOptions = {
  keys: [
    { name: 'name', weight: 0.5 },
    { name: 'description', weight: 0.2 },
    { name: 'keywords', weight: 0.2 },
    { name: 'path', weight: 0.1 },
  ],
  threshold: 0.4,
  includeScore: true,
  minMatchCharLength: 1,
};
