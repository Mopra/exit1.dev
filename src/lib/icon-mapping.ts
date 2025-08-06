// FontAwesome to Lucide React icon mapping
// This file helps with the migration from FontAwesome to Lucide React icons

export const iconMapping = {
  // Common icons
  faPlus: 'Plus',
  faSearch: 'Search',
  faCheck: 'Check',
  faTimes: 'X',
  faEdit: 'Edit',
  faTrash: 'Trash2',
  faUser: 'User',
  faCog: 'Settings',
  faChevronDown: 'ChevronDown',
  faChevronUp: 'ChevronUp',
  faChevronLeft: 'ChevronLeft',
  faChevronRight: 'ChevronRight',
  faArrowLeft: 'ArrowLeft',
  faArrowRightFromBracket: 'LogOut',
  faSignOutAlt: 'LogOut',
  faCheckCircle: 'CheckCircle',
  faTimesCircle: 'XCircle',
  faExclamationTriangle: 'AlertTriangle',
  faInfoCircle: 'Info',
  faQuestionCircle: 'HelpCircle',
  faCopy: 'Copy',
  faExternalLinkAlt: 'ExternalLink',
  faPlay: 'Play',
  faPause: 'Pause',
  faPauseCircle: 'PauseCircle',
  faEllipsisV: 'MoreVertical',
  faGlobe: 'Globe',
  faBell: 'Bell',
  faDatabase: 'Database',
  faCode: 'Code',
  faServer: 'Server',
  faShieldAlt: 'Shield',
  faClock: 'Clock',
  faCamera: 'Camera',
  faKey: 'Key',
  faLink: 'Link',
  faUnlink: 'Unlink',
  faSave: 'Save',
  faSpinner: 'Loader2',
} as const;

export type FontAwesomeIconName = keyof typeof iconMapping;
export type LucideIconName = typeof iconMapping[FontAwesomeIconName]; 