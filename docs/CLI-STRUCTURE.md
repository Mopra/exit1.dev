# CLI Project Structure Example

This document shows how your CLI project would be structured using the API-first approach, ensuring coherence with your web app.

## Project Structure

```
exit1-cli/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 # CLI entry point
│   ├── commands/
│   │   ├── websites.ts          # Website management commands
│   │   ├── webhooks.ts          # Webhook management commands
│   │   ├── auth.ts              # Authentication commands
│   │   └── system.ts            # System status commands
│   ├── api/
│   │   ├── client.ts            # API client (shared logic)
│   │   ├── types.ts             # Shared types (copy from web app)
│   │   └── auth.ts              # Authentication handling
│   ├── utils/
│   │   ├── logger.ts            # CLI logging utilities
│   │   ├── spinner.ts           # Loading indicators
│   │   └── table.ts             # Data table formatting
│   └── config/
│       └── firebase.ts          # Firebase configuration
├── docs/
│   └── API.md                   # API documentation (shared)
└── README.md
```

## Key Files

### 1. Package.json
```json
{
  "name": "exit1-cli",
  "version": "1.0.0",
  "description": "Exit1 Website Monitor CLI",
  "main": "dist/index.js",
  "bin": {
    "exit1": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "ts-node src/index.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "firebase-admin": "^11.0.0",
    "firebase-functions": "^4.0.0",
    "commander": "^9.0.0",
    "chalk": "^4.0.0",
    "ora": "^5.0.0",
    "cli-table3": "^0.6.0",
    "inquirer": "^8.0.0"
  },
  "devDependencies": {
    "@types/node": "^18.0.0",
    "typescript": "^4.9.0",
    "ts-node": "^10.9.0"
  }
}
```

### 2. API Client (src/api/client.ts)
```typescript
// This would be nearly identical to your web app's API client
// Just using Firebase Admin SDK instead of client SDK

import { getFunctions, httpsCallable } from 'firebase-functions';
import { initializeApp, cert } from 'firebase-admin/app';
import type { 
  ApiResponse,
  AddWebsiteRequest,
  UpdateWebsiteRequest,
  // ... other types from shared types
} from './types';

export class Exit1ApiClient {
  private functions = getFunctions();

  async addWebsite(request: AddWebsiteRequest): Promise<ApiResponse<{ id: string }>> {
    try {
      const addWebsite = httpsCallable(this.functions, "addWebsite");
      const result = await addWebsite(request);
      return { success: true, data: result.data as { id: string } };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to add website' 
      };
    }
  }

  // ... other methods identical to web app
}
```

### 3. Shared Types (src/api/types.ts)
```typescript
// This would be an exact copy of your web app's types
// Ensuring complete type consistency across all clients

export interface Website {
  id: string;
  url: string;
  name: string;
  userId: string;
  status: 'online' | 'offline' | 'unknown';
  // ... rest of the interface
}

// ... all other types from your web app
```

### 4. Website Commands (src/commands/websites.ts)
```typescript
import { Command } from 'commander';
import { apiClient } from '../api/client';
import { logger, spinner, table } from '../utils';

export const websitesCommand = new Command('websites')
  .description('Manage monitored websites')
  .addCommand(listCommand)
  .addCommand(addCommand)
  .addCommand(updateCommand)
  .addCommand(deleteCommand)
  .addCommand(checkCommand);

const listCommand = new Command('list')
  .description('List all monitored websites')
  .action(async () => {
    spinner.start('Loading websites...');
    
    // Use the same API client as web app
    const response = await apiClient.getWebsites();
    
    if (response.success && response.data) {
      spinner.succeed('Websites loaded');
      
      const tableData = response.data.map(website => [
        website.id,
        website.name,
        website.url,
        website.status,
        website.lastChecked ? new Date(website.lastChecked).toLocaleString() : 'Never'
      ]);
      
      table(tableData, ['ID', 'Name', 'URL', 'Status', 'Last Checked']);
    } else {
      spinner.fail('Failed to load websites');
      logger.error(response.error);
    }
  });

const addCommand = new Command('add')
  .description('Add a new website to monitor')
  .argument('<url>', 'Website URL')
  .option('-n, --name <name>', 'Display name')
  .action(async (url, options) => {
    spinner.start('Adding website...');
    
    const response = await apiClient.addWebsite({
      url,
      name: options.name
    });
    
    if (response.success) {
      spinner.succeed(`Website added successfully (ID: ${response.data?.id})`);
    } else {
      spinner.fail('Failed to add website');
      logger.error(response.error);
    }
  });

// ... other commands
```

### 5. Authentication (src/api/auth.ts)
```typescript
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFunctions } from 'firebase-functions';

export class AuthManager {
  private auth = getAuth();
  
  async authenticateWithToken(token: string) {
    try {
      const decodedToken = await this.auth.verifyIdToken(token);
      return { success: true, uid: decodedToken.uid };
    } catch (error) {
      return { success: false, error: 'Invalid token' };
    }
  }
  
  async loginWithEmail(email: string, password: string) {
    // Implement email/password login
  }
  
  async loginWithBrowser() {
    // Implement browser-based OAuth flow
  }
}
```

## Benefits of This Approach

### 1. **Shared API Logic**
- Both web app and CLI use identical API client logic
- Same error handling, validation, and response processing
- Changes to API automatically benefit both clients

### 2. **Type Safety**
- Shared TypeScript types ensure consistency
- Compile-time checking prevents API mismatches
- IDE autocomplete works across all projects

### 3. **Documentation Coherence**
- Single API documentation serves all clients
- Examples work for web, CLI, and future native apps
- Versioning and changes are documented once

### 4. **Development Efficiency**
- API changes only need to be made once
- Testing can be shared across clients
- Bug fixes benefit all platforms

### 5. **User Experience Consistency**
- Same error messages across all clients
- Consistent behavior and limits
- Familiar patterns for users

## Implementation Steps

1. **Copy shared types** from web app to CLI project
2. **Adapt API client** to use Firebase Admin SDK
3. **Implement CLI commands** using the shared API client
4. **Add authentication** handling for CLI context
5. **Test with same API endpoints** as web app

## Future Native Apps

The same pattern applies to native apps:

```typescript
// React Native example
import { apiClient } from './api/client';

const addWebsite = async (url: string, name: string) => {
  const response = await apiClient.addWebsite({ url, name });
  if (response.success) {
    // Handle success
  } else {
    // Handle error (same error handling as web/CLI)
  }
};
```

This ensures that all your clients (web, CLI, native) share the same:
- API endpoints and logic
- Data structures and validation
- Error handling and user feedback
- Documentation and examples 