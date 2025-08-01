# Exit1 API Documentation

This document serves as the single source of truth for all Exit1 API endpoints. All clients (web app, CLI tool, native apps) should use these documented endpoints and data structures.

## Authentication

All API endpoints require Firebase Authentication. The user must be authenticated with a valid Firebase ID token.

## Base Configuration

- **Project ID**: `exit1-dev`
- **Region**: Default Firebase region
- **Authentication**: Firebase Auth with Clerk integration

## API Endpoints

### Website Management

#### Add Website
- **Function**: `addCheck`
- **Method**: Callable Function
- **Request**:
  ```typescript
  {
    url: string;      // Required: Valid HTTP/HTTPS URL
    name?: string;    // Optional: Display name (defaults to URL)
  }
  ```
- **Response**:
  ```typescript
  {
    success: boolean;
    data?: { id: string };
    error?: string;
  }
  ```
- **Limits**: Up to 100 websites per user with spam protection
- **Validation**: URL must be valid HTTP/HTTPS format

#### Update Website
- **Function**: `updateCheck`
- **Method**: Callable Function
- **Request**:
  ```typescript
  {
    id: string;       // Required: Website ID
    url: string;      // Required: New URL
    name: string;     // Required: New display name
  }
  ```
- **Response**:
  ```typescript
  {
    success: boolean;
    error?: string;
  }
  ```

#### Delete Website
- **Function**: `deleteWebsite`
- **Method**: Callable Function
- **Request**:
  ```typescript
  {
    id: string;       // Required: Website ID
  }
  ```
- **Response**:
  ```typescript
  {
    success: boolean;
    error?: string;
  }
  ```

#### Toggle Website Status
- **Function**: `toggleCheckStatus`
- **Method**: Callable Function
- **Request**:
  ```typescript
  {
    id: string;           // Required: Website ID
    disabled: boolean;    // Required: Enable/disable status
    reason?: string;      // Optional: Reason for disabling
  }
  ```
- **Response**:
  ```typescript
  {
    success: boolean;
    data?: {
      disabled: boolean;
      message: string;
    };
    error?: string;
  }
  ```

#### Reorder Websites
- **Function**: `reorderWebsites`
- **Method**: Callable Function
- **Request**:
  ```typescript
  {
    fromIndex: number;    // Required: Current position
    toIndex: number;      // Required: New position
  }
  ```
- **Response**:
  ```typescript
  {
    success: boolean;
    error?: string;
  }
  ```

#### Manual Check
- **Function**: `manualCheck`
- **Method**: Callable Function
- **Request**:
  ```typescript
  {
    websiteId: string;    // Required: Website ID
  }
  ```
- **Response**:
  ```typescript
  {
    success: boolean;
    data?: {
      status: string;     // 'online' | 'offline'
      lastChecked: number;
    };
    error?: string;
  }
  ```



### Webhook Management

#### Save Webhook
- **Function**: `saveWebhookSettings`
- **Method**: Callable Function
- **Request**:
  ```typescript
  {
    url: string;                          // Required: Webhook URL
    name: string;                         // Required: Webhook name
    events: WebhookEvent[];               // Required: Array of events
    secret?: string;                      // Optional: HMAC secret
    headers?: Record<string, string>;     // Optional: Custom headers
  }
  ```
- **Response**:
  ```typescript
  {
    success: boolean;
    data?: { id: string };
    error?: string;
  }
  ```
- **Limits**: 5 webhooks per user

#### Update Webhook
- **Function**: `updateWebhookSettings`
- **Method**: Callable Function
- **Request**:
  ```typescript
  {
    id: string;                           // Required: Webhook ID
    url?: string;                         // Optional: New URL
    name?: string;                        // Optional: New name
    events?: WebhookEvent[];              // Optional: New events
    enabled?: boolean;                    // Optional: Enable/disable
    secret?: string;                      // Optional: New secret
    headers?: Record<string, string>;     // Optional: New headers
  }
  ```
- **Response**:
  ```typescript
  {
    success: boolean;
    error?: string;
  }
  ```

#### Delete Webhook
- **Function**: `deleteWebhook`
- **Method**: Callable Function
- **Request**:
  ```typescript
  {
    id: string;       // Required: Webhook ID
  }
  ```
- **Response**:
  ```typescript
  {
    success: boolean;
    error?: string;
  }
  ```

#### Test Webhook
- **Function**: `testWebhook`
- **Method**: Callable Function
- **Request**:
  ```typescript
  {
    id: string;       // Required: Webhook ID
  }
  ```
- **Response**:
  ```typescript
  {
    success: boolean;
    data?: {
      status: number;
      statusText: string;
      message: string;
    };
    error?: string;
  }
  ```

### System Management

#### Get System Status
- **Function**: `getSystemStatus`
- **Method**: Callable Function
- **Request**: `{}`
- **Response**:
  ```typescript
  {
    success: boolean;
    data?: {
      recentErrors: Array<{
        id: string;
        website: string;
        error: string;
        timestamp: number;
        status: string;
      }>;
      systemInfo: {
        uptime: number;
        memory: NodeJS.MemoryUsage;
        timestamp: number;
        version: string;
        platform: string;
      };
      services: {
        firestore: boolean;
        functions: boolean;
      };
    };
    error?: string;
  }
  ```



## Data Types

### Website
```typescript
interface Website {
  id: string;
  name: string;
  url: string;
  status?: 'online' | 'offline' | 'unknown';
  lastChecked?: number;
  downtimeCount?: number;
  lastDowntime?: number;
  createdAt?: number;
  updatedAt?: number;
  orderIndex?: number;
  lastStatusCode?: number;
  responseTime?: number;
  lastError?: string;
  userId?: string;
  
  // Cost optimization fields
  checkFrequency?: number;
  consecutiveFailures?: number;
  lastFailureTime?: number;
  userTier?: 'free' | 'premium';
  
  // Dead site management
  disabled?: boolean;
  disabledAt?: number;
  disabledReason?: string;
}
```

### WebhookSettings
```typescript
interface WebhookSettings {
  id?: string;
  userId: string;
  url: string;
  name: string;
  enabled: boolean;
  events: WebhookEvent[];
  secret?: string;
  headers?: { [key: string]: string };
  createdAt: number;
  updatedAt: number;
}
```

### WebhookEvent
```typescript
type WebhookEvent = 'website_down' | 'website_up' | 'website_error';
```

### WebhookPayload
```typescript
interface WebhookPayload {
  event: WebhookEvent;
  timestamp: number;
  website: {
    id: string;
    name: string;
    url: string;
    status: 'online' | 'offline' | 'unknown';
    responseTime?: number;
    lastError?: string;
  };
  previousStatus?: string;
  userId: string;
}
```

## Error Handling

All endpoints return consistent error responses:
```typescript
{
  success: false,
  error: string,        // Human-readable error message
  message?: string      // Additional context
}
```

Common error scenarios:
- **Authentication required**: User not authenticated
- **Invalid URL**: URL format validation failed
- **Website not found**: Website ID doesn't exist or user doesn't own it
- **Insufficient permissions**: User doesn't own the resource
- **Limit exceeded**: User has reached maximum allowed items
- **Duplicate entry**: Resource already exists
- **Rate limit exceeded**: Too many requests in a short time period
- **Suspicious pattern detected**: Spam protection triggered
- **Domain not allowed**: URL contains blocked or invalid domain

## Rate Limiting & Spam Protection

### Rate Limits
- **Checks per minute**: 10 checks per user per minute
- **Checks per hour**: 100 checks per user per hour  
- **Checks per day**: 500 checks per user per day
- **Maximum checks per user**: 100 total checks

### Spam Protection
- **URL validation**: Minimum 10 characters, maximum 2048 characters
- **Protocol restrictions**: Only HTTP and HTTPS allowed
- **Blocked domains**: Localhost, private IPs, test domains blocked
- **Pattern detection**: Prevents excessive similar URLs or names
- **Duplicate prevention**: Same URL cannot be added multiple times

### Other Limits
- **Manual checks**: Limited to prevent abuse
- **Webhook tests**: Limited to prevent spam
- **General operations**: Standard Firebase Functions limits apply

## Webhook Security

When a webhook secret is provided, the payload is signed with HMAC-SHA256:
- **Header**: `X-Exit1-Signature: sha256=<signature>`
- **Algorithm**: HMAC-SHA256
- **Key**: Webhook secret
- **Data**: JSON stringified payload

## Client Implementation Guidelines

### Web App (React)
- Use Firebase SDK for authentication
- Use `httpsCallable` for function calls
- Handle real-time updates with Firestore listeners

### CLI Tool (Node.js)
- Use Firebase Admin SDK for authentication
- Use Firebase Functions SDK for function calls
- Implement proper error handling and user feedback

### Native Apps
- Use Firebase SDK for respective platform
- Implement offline capability where possible
- Handle authentication token refresh

## Versioning

API versioning is handled through Firebase Functions deployment. Breaking changes will be communicated through:
- Function name changes (e.g., `addWebsiteV2`)
- New optional parameters
- Deprecation warnings in responses

## Support

For API support and questions:
- Check this documentation first
- Review Firebase Functions logs
- Contact development team for issues 