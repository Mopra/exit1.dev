/**
 * API key scope definitions and enforcement helpers.
 *
 * Scopes control which public API operations an API key can perform.
 * Existing keys with no scopes default to read-only access.
 */

export const API_SCOPES = {
  CHECKS_READ: 'checks:read',
  CHECKS_WRITE: 'checks:write',
  CHECKS_DELETE: 'checks:delete',
  // Alert channels are a separate capability from checks: creating a webhook
  // points our servers at an arbitrary URL, which a checks:write key has no
  // business doing. Keys minted before these existed carry neither.
  ALERTS_READ: 'alerts:read',
  ALERTS_WRITE: 'alerts:write',
} as const;

export type ApiScope = typeof API_SCOPES[keyof typeof API_SCOPES];

export const ALL_SCOPES: ApiScope[] = Object.values(API_SCOPES);

// Keys created before scopes existed have scopes: [] — treat as read-only
export const DEFAULT_SCOPES: ApiScope[] = [API_SCOPES.CHECKS_READ];

export function hasScope(keyScopes: string[] | undefined, requiredScope: ApiScope): boolean {
  const effective = keyScopes && keyScopes.length > 0 ? keyScopes : DEFAULT_SCOPES;
  return effective.includes(requiredScope);
}
