# API-First Strategy for Exit1

This document outlines the API-first development strategy that ensures coherence across your web app, CLI tool, and future native applications.

## Overview

The API-first approach treats your Firebase Functions as the single source of truth for all business logic. All clients (web, CLI, native apps) consume the same API endpoints, ensuring consistency, maintainability, and scalability.

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Web App       │    │   CLI Tool      │    │  Native Apps    │
│   (React)       │    │   (Node.js)     │    │  (React Native) │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌─────────────────┐
                    │  Shared API     │
                    │  Layer          │
                    └─────────────────┘
                                 │
                    ┌─────────────────┐
                    │ Firebase        │
                    │ Functions       │
                    └─────────────────┘
                                 │
                    ┌─────────────────┐
                    │ Firestore       │
                    │ Database        │
                    └─────────────────┘
```

## Key Components

### 1. Firebase Functions (Backend)
- **Location**: `functions/src/index.ts`
- **Purpose**: Single source of truth for all business logic
- **Features**: Authentication, validation, data processing, webhooks

### 2. Shared API Client
- **Web App**: `src/api/client.ts`
- **CLI Tool**: `src/api/client.ts` (adapted for Node.js)
- **Purpose**: Consistent API interaction across all clients

### 3. Shared Types
- **Location**: `src/api/types.ts` (copied to each project)
- **Purpose**: Type safety and consistency across all clients

### 4. API Documentation
- **Location**: `docs/API.md`
- **Purpose**: Single source of truth for API endpoints

## Benefits

### 1. **Consistency**
- Same API endpoints across all clients
- Identical error handling and validation
- Consistent user experience

### 2. **Maintainability**
- Business logic centralized in Firebase Functions
- Changes automatically propagate to all clients
- Single place to fix bugs and add features

### 3. **Scalability**
- Easy to add new clients (CLI, native apps)
- API versioning handled centrally
- Performance optimizations benefit all clients

### 4. **Development Efficiency**
- Shared code reduces duplication
- Type safety prevents API mismatches
- Faster development of new features

### 5. **Testing**
- API can be tested independently
- Client-specific tests focus on UI/UX
- Integration tests cover all scenarios

## Implementation Strategy

### Phase 1: Web App API Layer (Current)
✅ **Completed**
- Created `src/api/client.ts` with comprehensive API client
- Added `src/api/types.ts` with shared types
- Updated `src/types.ts` to include webhook types
- Created `docs/API.md` with complete documentation

### Phase 2: CLI Tool Development
🔄 **Next Steps**
1. Create new CLI project repository
2. Copy shared types from web app
3. Adapt API client for Node.js environment
4. Implement CLI commands using shared API client
5. Add authentication handling for CLI context

### Phase 3: Native App Development
📋 **Future**
1. Create React Native project
2. Copy shared types and API client
3. Adapt for mobile environment
4. Implement mobile-specific UI components

## Shared Components

### API Client Methods
All clients share these core methods:

```typescript
// Website Management
addWebsite(request: AddWebsiteRequest): Promise<ApiResponse<{ id: string }>>
updateWebsite(request: UpdateWebsiteRequest): Promise<ApiResponse>
deleteWebsite(id: string): Promise<ApiResponse>
toggleWebsiteStatus(request: ToggleWebsiteStatusRequest): Promise<ApiResponse>
reorderWebsites(request: ReorderWebsitesRequest): Promise<ApiResponse>
manualCheck(websiteId: string): Promise<ApiResponse>

// Webhook Management
saveWebhook(request: SaveWebhookRequest): Promise<ApiResponse<{ id: string }>>
updateWebhook(request: UpdateWebhookRequest): Promise<ApiResponse>
deleteWebhook(id: string): Promise<ApiResponse>
testWebhook(id: string): Promise<ApiResponse>

// System Management
getSystemStatus(): Promise<ApiResponse<SystemStatus>>

// Discord Integration
handleDiscordAuth(request: DiscordAuthRequest): Promise<ApiResponse>
```

### Shared Types
All clients use identical TypeScript interfaces:

```typescript
interface Website {
  id: string;
  url: string;
  name: string;
  userId: string;
  status: 'online' | 'offline' | 'unknown';
  // ... all other fields
}

interface WebhookSettings {
  id?: string;
  userId: string;
  url: string;
  name: string;
  enabled: boolean;
  events: WebhookEvent[];
  // ... all other fields
}

// ... all other shared types
```

## Authentication Strategy

### Web App
- Uses Firebase Auth with Clerk integration
- Real-time authentication state management
- Automatic token refresh

### CLI Tool
- Firebase Admin SDK for authentication
- Token-based authentication
- Browser-based OAuth flow for initial setup

### Native Apps
- Firebase Auth SDK for respective platform
- Biometric authentication support
- Offline authentication handling

## Error Handling

All clients share consistent error handling:

```typescript
interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
```

Common error scenarios:
- Authentication required
- Invalid URL format
- Resource not found
- Insufficient permissions
- Rate limiting
- Validation errors

## Versioning Strategy

### API Versioning
- Firebase Functions handle versioning
- Breaking changes use new function names (e.g., `addWebsiteV2`)
- Deprecation warnings in responses
- Backward compatibility maintained

### Client Versioning
- Each client has independent versioning
- Shared types versioned separately
- Documentation updated for all clients

## Development Workflow

### 1. API Changes
1. Update Firebase Functions
2. Update shared types
3. Update API documentation
4. Test with web app
5. Deploy functions

### 2. Client Updates
1. Copy updated types to all clients
2. Update API client if needed
3. Test all clients
4. Deploy updated clients

### 3. New Feature Development
1. Design API endpoint
2. Implement in Firebase Functions
3. Add to shared types
4. Update API documentation
5. Implement in all clients
6. Test and deploy

## Testing Strategy

### API Testing
- Unit tests for Firebase Functions
- Integration tests for API endpoints
- Load testing for performance

### Client Testing
- Unit tests for API client
- Integration tests with mock API
- End-to-end tests for user workflows

### Cross-Client Testing
- Ensure consistent behavior across clients
- Test error handling scenarios
- Validate type safety

## Monitoring and Analytics

### API Monitoring
- Firebase Functions logs
- Performance metrics
- Error tracking
- Usage analytics

### Client Monitoring
- User behavior analytics
- Error reporting
- Performance monitoring
- Feature usage tracking

## Security Considerations

### API Security
- Firebase Auth integration
- Input validation
- Rate limiting
- CORS configuration

### Client Security
- Secure token storage
- Network security
- Data encryption
- Privacy compliance

## Future Considerations

### Microservices Migration
- API-first approach makes migration easier
- Functions can be split into microservices
- Clients remain unchanged during migration

### GraphQL Integration
- Can add GraphQL layer on top of existing API
- Maintains backward compatibility
- Provides more flexible querying

### Real-time Features
- WebSocket support for real-time updates
- Push notifications for status changes
- Live collaboration features

## Conclusion

The API-first strategy provides a solid foundation for building a cohesive ecosystem of applications. By centralizing business logic in Firebase Functions and sharing API clients and types across all projects, you ensure:

1. **Consistency** across all user experiences
2. **Efficiency** in development and maintenance
3. **Scalability** for future growth
4. **Reliability** through shared testing and validation

This approach will serve you well as you expand from web app to CLI tool to native applications, ensuring that all your users have a consistent and reliable experience regardless of which platform they choose to use. 