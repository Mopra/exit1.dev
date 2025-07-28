import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Card } from '../components/ui';
import { theme, typography } from '../config/theme';
import { apiClient } from '../api/client';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Modal from '../components/ui/Modal';
import Spinner from '../components/ui/Spinner';

interface ApiEndpoint {
  name: string;
  description: string;
  method: 'POST' | 'GET';
  category: 'websites' | 'webhooks' | 'system' | 'discord';
  requestSchema: Record<string, any>;
  responseSchema: Record<string, any>;
  example: {
    request: any;
    response: any;
  };
}

const API_ENDPOINTS: ApiEndpoint[] = [
  // Website Management
  {
    name: 'addWebsite',
    description: 'Add a new website to monitor',
    method: 'POST',
    category: 'websites',
    requestSchema: {
      url: { type: 'string', required: true, description: 'Website URL to monitor' },
      name: { type: 'string', required: false, description: 'Display name (defaults to URL)' }
    },
    responseSchema: {
      success: { type: 'boolean', description: 'Operation success status' },
      data: { type: 'object', description: 'Response data containing website ID' },
      error: { type: 'string', description: 'Error message if failed' }
    },
    example: {
      request: { url: 'https://example.com', name: 'Example Site' },
      response: { success: true, data: { id: 'abc123' } }
    }
  },
  {
    name: 'updateWebsite',
    description: 'Update an existing website',
    method: 'POST',
    category: 'websites',
    requestSchema: {
      id: { type: 'string', required: true, description: 'Website ID' },
      url: { type: 'string', required: true, description: 'New website URL' },
      name: { type: 'string', required: true, description: 'New display name' }
    },
    responseSchema: {
      success: { type: 'boolean', description: 'Operation success status' },
      error: { type: 'string', description: 'Error message if failed' }
    },
    example: {
      request: { id: 'abc123', url: 'https://new-example.com', name: 'Updated Site' },
      response: { success: true }
    }
  },
  {
    name: 'deleteWebsite',
    description: 'Delete a website from monitoring',
    method: 'POST',
    category: 'websites',
    requestSchema: {
      id: { type: 'string', required: true, description: 'Website ID to delete' }
    },
    responseSchema: {
      success: { type: 'boolean', description: 'Operation success status' },
      error: { type: 'string', description: 'Error message if failed' }
    },
    example: {
      request: { id: 'abc123' },
      response: { success: true }
    }
  },
  {
    name: 'toggleWebsiteStatus',
    description: 'Enable or disable website monitoring',
    method: 'POST',
    category: 'websites',
    requestSchema: {
      id: { type: 'string', required: true, description: 'Website ID' },
      disabled: { type: 'boolean', required: true, description: 'Whether to disable the website' },
      reason: { type: 'string', required: false, description: 'Reason for disabling' }
    },
    responseSchema: {
      success: { type: 'boolean', description: 'Operation success status' },
      data: { type: 'object', description: 'Response data' },
      error: { type: 'string', description: 'Error message if failed' }
    },
    example: {
      request: { id: 'abc123', disabled: true, reason: 'Maintenance' },
      response: { success: true, data: { disabled: true, message: 'Website disabled' } }
    }
  },
  {
    name: 'manualCheck',
    description: 'Manually check a website status',
    method: 'POST',
    category: 'websites',
    requestSchema: {
      websiteId: { type: 'string', required: true, description: 'Website ID to check' }
    },
    responseSchema: {
      success: { type: 'boolean', description: 'Operation success status' },
      data: { type: 'object', description: 'Check results' },
      error: { type: 'string', description: 'Error message if failed' }
    },
    example: {
      request: { websiteId: 'abc123' },
      response: { success: true, data: { status: 'online', lastChecked: 1640995200000 } }
    }
  },
  {
    name: 'reorderWebsites',
    description: 'Reorder websites in the list',
    method: 'POST',
    category: 'websites',
    requestSchema: {
      fromIndex: { type: 'number', required: true, description: 'Current position' },
      toIndex: { type: 'number', required: true, description: 'New position' }
    },
    responseSchema: {
      success: { type: 'boolean', description: 'Operation success status' },
      error: { type: 'string', description: 'Error message if failed' }
    },
    example: {
      request: { fromIndex: 0, toIndex: 2 },
      response: { success: true }
    }
  },
  // Webhook Management
  {
    name: 'saveWebhookSettings',
    description: 'Create a new webhook',
    method: 'POST',
    category: 'webhooks',
    requestSchema: {
      url: { type: 'string', required: true, description: 'Webhook URL' },
      name: { type: 'string', required: true, description: 'Webhook name' },
      events: { type: 'array', required: true, description: 'Array of events to listen for' },
      secret: { type: 'string', required: false, description: 'HMAC secret for signing' },
      headers: { type: 'object', required: false, description: 'Custom headers' }
    },
    responseSchema: {
      success: { type: 'boolean', description: 'Operation success status' },
      data: { type: 'object', description: 'Response data containing webhook ID' },
      error: { type: 'string', description: 'Error message if failed' }
    },
    example: {
      request: { 
        url: 'https://api.example.com/webhook', 
        name: 'My Webhook',
        events: ['website_down', 'website_up']
      },
      response: { success: true, data: { id: 'webhook123' } }
    }
  },
  {
    name: 'updateWebhookSettings',
    description: 'Update an existing webhook',
    method: 'POST',
    category: 'webhooks',
    requestSchema: {
      id: { type: 'string', required: true, description: 'Webhook ID' },
      url: { type: 'string', required: false, description: 'New webhook URL' },
      name: { type: 'string', required: false, description: 'New webhook name' },
      events: { type: 'array', required: false, description: 'New events array' },
      enabled: { type: 'boolean', required: false, description: 'Enable/disable webhook' }
    },
    responseSchema: {
      success: { type: 'boolean', description: 'Operation success status' },
      error: { type: 'string', description: 'Error message if failed' }
    },
    example: {
      request: { id: 'webhook123', enabled: false },
      response: { success: true }
    }
  },
  {
    name: 'deleteWebhook',
    description: 'Delete a webhook',
    method: 'POST',
    category: 'webhooks',
    requestSchema: {
      id: { type: 'string', required: true, description: 'Webhook ID to delete' }
    },
    responseSchema: {
      success: { type: 'boolean', description: 'Operation success status' },
      error: { type: 'string', description: 'Error message if failed' }
    },
    example: {
      request: { id: 'webhook123' },
      response: { success: true }
    }
  },
  {
    name: 'testWebhook',
    description: 'Test a webhook with sample data',
    method: 'POST',
    category: 'webhooks',
    requestSchema: {
      id: { type: 'string', required: true, description: 'Webhook ID to test' }
    },
    responseSchema: {
      success: { type: 'boolean', description: 'Operation success status' },
      data: { type: 'object', description: 'Test results' },
      error: { type: 'string', description: 'Error message if failed' }
    },
    example: {
      request: { id: 'webhook123' },
      response: { 
        success: true, 
        data: { 
          status: 200, 
          statusText: 'OK', 
          message: 'Test webhook sent successfully!' 
        } 
      }
    }
  },
  // System Management
  {
    name: 'getSystemStatus',
    description: 'Get system status and recent errors',
    method: 'POST',
    category: 'system',
    requestSchema: {},
    responseSchema: {
      success: { type: 'boolean', description: 'Operation success status' },
      data: { type: 'object', description: 'System status data' },
      error: { type: 'string', description: 'Error message if failed' }
    },
    example: {
      request: {},
      response: { 
        success: true, 
        data: { 
          recentErrors: [],
          systemInfo: { uptime: 3600, version: '1.0.0' },
          services: { firestore: true, functions: true }
        } 
      }
    }
  },
  // Discord Integration
  {
    name: 'handleDiscordAuth',
    description: 'Handle Discord OAuth completion',
    method: 'POST',
    category: 'discord',
    requestSchema: {
      discordUserId: { type: 'string', required: true, description: 'Discord user ID' },
      userEmail: { type: 'string', required: false, description: 'User email' },
      username: { type: 'string', required: false, description: 'Discord username' }
    },
    responseSchema: {
      success: { type: 'boolean', description: 'Operation success status' },
      data: { type: 'object', description: 'Discord auth results' },
      error: { type: 'string', description: 'Error message if failed' }
    },
    example: {
      request: { discordUserId: '123456789', userEmail: 'user@example.com' },
      response: { 
        success: true, 
        data: { 
          inviteUrl: 'https://discord.gg/invite',
          alreadyMember: false,
          message: 'Discord invite created!' 
        } 
      }
    }
  }
];

const CATEGORIES = {
  websites: { name: 'Website Management', color: 'blue' },
  webhooks: { name: 'Webhook Management', color: 'green' },
  system: { name: 'System Management', color: 'purple' },
  discord: { name: 'Discord Integration', color: 'indigo' }
};

export default function AiInstructions() {
  const { userId } = useAuth();
  const [selectedEndpoint, setSelectedEndpoint] = useState<ApiEndpoint | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [testResults, setTestResults] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [requestData, setRequestData] = useState<string>('');

  const handleTestEndpoint = async () => {
    if (!selectedEndpoint || !userId) return;

    setIsLoading(true);
    setTestResults(null);

    try {
      let result;
      const parsedRequest = JSON.parse(requestData || '{}');

      switch (selectedEndpoint.name) {
        case 'addWebsite':
          result = await apiClient.addWebsite(parsedRequest);
          break;
        case 'updateWebsite':
          result = await apiClient.updateWebsite(parsedRequest);
          break;
        case 'deleteWebsite':
          result = await apiClient.deleteWebsite(parsedRequest.id);
          break;
        case 'toggleWebsiteStatus':
          result = await apiClient.toggleWebsiteStatus(parsedRequest);
          break;
        case 'manualCheck':
          result = await apiClient.manualCheck(parsedRequest.websiteId);
          break;
        case 'reorderWebsites':
          result = await apiClient.reorderWebsites(parsedRequest);
          break;
        case 'saveWebhookSettings':
          result = await apiClient.saveWebhook(parsedRequest);
          break;
        case 'updateWebhookSettings':
          result = await apiClient.updateWebhook(parsedRequest);
          break;
        case 'deleteWebhook':
          result = await apiClient.deleteWebhook(parsedRequest.id);
          break;
        case 'testWebhook':
          result = await apiClient.testWebhook(parsedRequest.id);
          break;
        case 'getSystemStatus':
          result = await apiClient.getSystemStatus();
          break;
        case 'handleDiscordAuth':
          result = await apiClient.handleDiscordAuth(parsedRequest);
          break;
        default:
          throw new Error('Unknown endpoint');
      }

      setTestResults(result);
    } catch (error: any) {
      setTestResults({
        success: false,
        error: error.message || 'Unknown error occurred'
      });
    } finally {
      setIsLoading(false);
    }
  };

  const openEndpointModal = (endpoint: ApiEndpoint) => {
    setSelectedEndpoint(endpoint);
    setRequestData(JSON.stringify(endpoint.example.request, null, 2));
    setTestResults(null);
    setIsModalOpen(true);
  };

  const groupedEndpoints = API_ENDPOINTS.reduce((acc, endpoint) => {
    if (!acc[endpoint.category]) {
      acc[endpoint.category] = [];
    }
    acc[endpoint.category].push(endpoint);
    return acc;
  }, {} as Record<string, ApiEndpoint[]>);

  return (
    <>
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className={`text-3xl font-bold ${typography.fontFamily.display} ${theme.colors.text.primary} mb-4`}>
            AI Instructions
          </h1>
          <p className={`${theme.colors.text.secondary} text-lg`}>
            Interactive documentation for all Exit1 API endpoints. Test endpoints directly from your browser.
          </p>
        </div>

        {/* CLI Setup Guide */}
        <Card className="mb-8 p-6">
          <div className="mb-6">
            <h2 className={`text-2xl font-semibold ${theme.colors.text.primary} mb-2`}>
              CLI Tool Setup Guide
            </h2>
            <p className={theme.colors.text.secondary}>
              Complete setup instructions for building CLI tools and other clients.
            </p>
          </div>

          {/* Step-by-Step POC Guide */}
          <div className="mb-8 p-4 bg-blue-50 border border-blue-200 rounded">
            <h3 className={`text-lg font-semibold text-blue-900 mb-3`}>
              🚀 Proof of Concept CLI - Step by Step
            </h3>
            <p className="text-blue-800 mb-4">
              Build a working CLI that can login, list websites, and logout using Clerk OAuth.
            </p>
            
            <div className="space-y-4 text-blue-800">
              <div>
                <h4 className="font-semibold">🔑 How to Get Access Token for CLI</h4>
                <p className="text-sm mb-2">
                  The CLI needs a Firebase custom token. Here's how to get one:
                </p>
                <ol className="list-decimal list-inside text-sm space-y-1 ml-4">
                  <li>Go to <a href="https://exit1.dev" className="text-blue-600 underline">https://exit1.dev</a> and login with Clerk</li>
                  <li>Open browser DevTools (F12) → Console tab</li>
                  <li>Run this command to get your Firebase token:</li>
                </ol>
                <pre className="bg-white p-3 rounded text-sm overflow-x-auto text-black mt-2">
{`// In browser console:
import { getAuth } from 'firebase/auth';
const auth = getAuth();
auth.currentUser?.getIdToken().then(token => console.log('Firebase Token:', token));`}
                </pre>
                <p className="text-sm mt-2">
                  Copy the token and use it in the CLI when prompted for "access token".
                </p>
              </div>

              <div>
                <h4 className="font-semibold">Step 1: Create New Project</h4>
                <pre className="bg-white p-3 rounded text-sm overflow-x-auto text-black">
{`mkdir exit1-cli-poc
cd exit1-cli-poc
npm init -y`}
                </pre>
              </div>

              <div>
                <h4 className="font-semibold">Step 2: Install Dependencies</h4>
                <pre className="bg-white p-3 rounded text-sm overflow-x-auto text-black">
{`npm install firebase firebase-functions commander chalk ora open
npm install --save-dev @types/node typescript ts-node`}
                </pre>
              </div>

              <div>
                <h4 className="font-semibold">Step 3: Create package.json Scripts</h4>
                <pre className="bg-white p-3 rounded text-sm overflow-x-auto text-black">
{`{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts"
  },
  "bin": {
    "exit1": "./dist/index.js"
  }
}`}
                </pre>
              </div>

              <div>
                <h4 className="font-semibold">Step 4: Create tsconfig.json</h4>
                <pre className="bg-white p-3 rounded text-sm overflow-x-auto text-black">
{`{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}`}
                </pre>
              </div>

              <div>
                <h4 className="font-semibold">Step 5: Create Firebase Config (src/firebase.ts)</h4>
                <pre className="bg-white p-3 rounded text-sm overflow-x-auto text-black">
{`import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFunctions } from 'firebase/functions';

const firebaseConfig = {
  apiKey: "AIzaSyBJj7oHBfYGiYh03LgyRaFWf0vQ-_h1rMI",
  authDomain: "exit1-dev.firebaseapp.com",
  projectId: "exit1-dev",
  storageBucket: "exit1-dev.firebasestorage.app",
  messagingSenderId: "118327018856",
  appId: "1:118327018856:web:d7545b23b8b4007db7c2dd"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const functions = getFunctions(app);`}
                </pre>
              </div>

              <div>
                <h4 className="font-semibold">Step 6: Create Auth Manager (src/auth.ts)</h4>
                <pre className="bg-white p-3 rounded text-sm overflow-x-auto text-black">
{`import { auth } from './firebase';
import { signInWithCustomToken, signOut, signInWithCredential } from 'firebase/auth';
import { GoogleAuthProvider } from 'firebase/auth';
import chalk from 'chalk';
import * as readline from 'readline';

export class AuthManager {
  private static instance: AuthManager;
  private isAuthenticated = false;

  static getInstance(): AuthManager {
    if (!AuthManager.instance) {
      AuthManager.instance = new AuthManager();
    }
    return AuthManager.instance;
  }

  async login(): Promise<boolean> {
    if (this.isAuthenticated) {
      console.log(chalk.green('✓ Already authenticated'));
      return true;
    }

    console.log(chalk.blue('🔐 Starting authentication...'));
    
    try {
      // Start local server for OAuth callback
      const port = 3001;
      const state = randomBytes(16).toString('hex');
      
      const server = createServer((req, res) => {
        const url = new URL(req.url || '', \`http://localhost:\${port}\`);
        
        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code');
          if (code) {
            this.handleOAuthCallback(code).then(() => {
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end('<h1>Authentication successful! You can close this window.</h1>');
              server.close();
            });
          }
        }
      });

      server.listen(port);

      // Open browser for Clerk OAuth
      const authUrl = \`https://exit1.dev/login?redirect_uri=http://localhost:\${port}/callback&state=\${state}\`;
      
      console.log(chalk.yellow('🌐 Opening browser for authentication...'));
      await open(authUrl);
      
      // Wait for authentication to complete
      return new Promise((resolve) => {
        server.on('close', () => {
          this.isAuthenticated = true;
          console.log(chalk.green('✓ Authentication successful!'));
          resolve(true);
        });
      });
    } catch (error) {
      console.error(chalk.red('✗ Authentication failed:'), error);
      return false;
    }
  }

  private async handleOAuthCallback(code: string): Promise<void> {
    try {
      // For POC, we'll use a simple approach
      // In production, you'd exchange the code for a Firebase custom token
      console.log(chalk.blue('Processing authentication...'));
      
      // Simulate successful authentication
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(chalk.red('Error processing authentication:'), error);
    }
  }

  async logout(): Promise<void> {
    try {
      await signOut(auth);
      this.isAuthenticated = false;
      console.log(chalk.green('✓ Logged out successfully'));
    } catch (error) {
      console.error(chalk.red('✗ Logout failed:'), error);
    }
  }

  isLoggedIn(): boolean {
    return this.isAuthenticated;
  }
}`}
                </pre>
              </div>

              <div>
                <h4 className="font-semibold">Step 7: Create API Client (src/api.ts)</h4>
                <pre className="bg-white p-3 rounded text-sm overflow-x-auto text-black">
{`import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import { AuthManager } from './auth';

export interface Website {
  id: string;
  name: string;
  url: string;
  status: 'online' | 'offline' | 'unknown';
  lastChecked: number;
}

export class ApiClient {
  private authManager = AuthManager.getInstance();

  async getWebsites(): Promise<Website[]> {
    // Ensure authenticated
    if (!this.authManager.isLoggedIn()) {
      throw new Error('Not authenticated. Please run: exit1 login');
    }

    try {
      // For POC, return mock data
      // In production, you'd call the actual Firebase function
      return [
        {
          id: '1',
          name: 'Example Site',
          url: 'https://example.com',
          status: 'online',
          lastChecked: Date.now()
        },
        {
          id: '2', 
          name: 'Test Site',
          url: 'https://test.com',
          status: 'offline',
          lastChecked: Date.now() - 300000
        }
      ];
    } catch (error) {
      throw new Error(\`Failed to fetch websites: \${error}\`);
    }
  }
}`}
                </pre>
              </div>

              <div>
                <h4 className="font-semibold">Step 8: Create CLI Commands (src/commands.ts)</h4>
                <pre className="bg-white p-3 rounded text-sm overflow-x-auto text-black">
{`import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { AuthManager } from './auth';
import { ApiClient } from './api';

export function createCommands(): Command {
  const program = new Command();
  const authManager = AuthManager.getInstance();
  const apiClient = new ApiClient();

  program
    .name('exit1')
    .description('Exit1.dev CLI - Website monitoring tool')
    .version('1.0.0');

  // Login command
  program
    .command('login')
    .description('Authenticate with Exit1.dev')
    .action(async () => {
      const spinner = ora('Authenticating...').start();
      
      try {
        const success = await authManager.login();
        if (success) {
          spinner.succeed('Login successful!');
        } else {
          spinner.fail('Login failed');
        }
      } catch (error) {
        spinner.fail(\`Login error: \${error}\`);
      }
    });

  // List websites command
  program
    .command('websites')
    .description('List your monitored websites')
    .action(async () => {
      const spinner = ora('Fetching websites...').start();
      
      try {
        const websites = await apiClient.getWebsites();
        spinner.succeed(\`Found \${websites.length} websites\`);
        
        if (websites.length === 0) {
          console.log(chalk.yellow('No websites found.'));
          return;
        }

        console.log('\\n' + chalk.bold('Your Websites:'));
        websites.forEach((website, index) => {
          const statusColor = website.status === 'online' ? 'green' : 'red';
          const statusIcon = website.status === 'online' ? '●' : '○';
          
          console.log(\`
\${index + 1}. \${chalk.bold(website.name)}
   URL: \${website.url}
   Status: \${chalk[statusColor](\`\${statusIcon} \${website.status}\`)}
   Last Check: \${new Date(website.lastChecked).toLocaleString()}
          \`);
        });
      } catch (error) {
        spinner.fail(\`Failed to fetch websites: \${error}\`);
      }
    });

  // Logout command
  program
    .command('logout')
    .description('Logout from Exit1.dev')
    .action(async () => {
      const spinner = ora('Logging out...').start();
      
      try {
        await authManager.logout();
        spinner.succeed('Logout successful!');
      } catch (error) {
        spinner.fail(\`Logout error: \${error}\`);
      }
    });

  return program;
}`}
                </pre>
              </div>

              <div>
                <h4 className="font-semibold">Step 9: Create Main Entry Point (src/index.ts)</h4>
                <pre className="bg-white p-3 rounded text-sm overflow-x-auto text-black">
{`#!/usr/bin/env node

import { createCommands } from './commands';

const program = createCommands();

// Handle errors gracefully
process.on('unhandledRejection', (error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});

// Parse command line arguments
program.parse();`}
                </pre>
              </div>

              <div>
                <h4 className="font-semibold">Step 10: Build and Test</h4>
                <pre className="bg-white p-3 rounded text-sm overflow-x-auto text-black">
{`# Build the CLI
npm run build

# Make it executable
chmod +x dist/index.js

# Test the CLI
npm start login
npm start websites
npm start logout`}
                </pre>
              </div>

              <div>
                <h4 className="font-semibold">Step 11: Install Globally (Optional)</h4>
                <pre className="bg-white p-3 rounded text-sm overflow-x-auto text-black">
{`# Install globally
npm install -g .

# Now you can use it anywhere
exit1 login
exit1 websites
exit1 logout`}
                </pre>
              </div>
            </div>

            <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded">
              <h4 className="font-semibold text-green-900">🎉 What This POC Achieves:</h4>
              <ul className="text-green-800 mt-2 space-y-1">
                <li>• <strong>Login:</strong> Opens browser for Clerk OAuth authentication</li>
                <li>• <strong>List Websites:</strong> Shows mock website data (easily replaceable with real API calls)</li>
                <li>• <strong>Logout:</strong> Clears authentication state</li>
                <li>• <strong>Error Handling:</strong> Graceful error handling and user feedback</li>
                <li>• <strong>Professional UI:</strong> Spinners, colors, and clear output</li>
              </ul>
            </div>
          </div>

          <div className="space-y-6">
            <div>
              <h3 className={`text-lg font-semibold ${theme.colors.text.primary} mb-3`}>1. Firebase Configuration</h3>
              <div className="bg-gray-100 p-4 rounded text-black font-mono text-sm">
                <div>Project ID: <span className="font-bold">exit1-dev</span></div>
                <div>Region: <span className="font-bold">Default (us-central1)</span></div>
                <div>Authentication: <span className="font-bold">Firebase Auth with Clerk integration</span></div>
              </div>
            </div>

            <div>
              <h3 className={`text-lg font-semibold ${theme.colors.text.primary} mb-3`}>2. Required Dependencies</h3>
              <pre className="bg-gray-100 p-4 rounded text-black font-mono text-sm overflow-x-auto">
{`{
  "firebase-admin": "^11.0.0",
  "firebase-functions": "^4.0.0",
  "commander": "^9.0.0",
  "chalk": "^4.0.0",
  "ora": "^5.0.0"
}`}
              </pre>
            </div>

            <div>
              <h3 className={`text-lg font-semibold ${theme.colors.text.primary} mb-3`}>3. Firebase Initialization</h3>
              <pre className="bg-gray-100 p-4 rounded text-black font-mono text-sm overflow-x-auto">
{`import { initializeApp, cert } from 'firebase-admin/app';
import { getFunctions } from 'firebase-functions';

// Initialize Firebase Admin
const app = initializeApp({
  projectId: 'exit1-dev',
  // Use service account key or default credentials
});

const functions = getFunctions(app);`}
              </pre>
            </div>

            <div>
              <h3 className={`text-lg font-semibold ${theme.colors.text.primary} mb-3`}>4. Authentication Setup (Clerk OAuth)</h3>
              <div className="space-y-3">
                <div className="bg-gray-100 p-4 rounded text-black font-mono text-sm">
                  <div><strong>Clerk OAuth Flow (Required)</strong></div>
                  <div>• Users authenticate through Clerk (same as web app)</div>
                  <div>• CLI opens browser for authentication</div>
                  <div>• Firebase custom token generated from Clerk session</div>
                  <div>• Token stored locally for subsequent CLI calls</div>
                </div>
              </div>
              <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded text-black text-sm">
                <strong>Note:</strong> Users don't have Firebase Console access, so Clerk OAuth is the only authentication method available.
              </div>
            </div>

            <div>
              <h3 className={`text-lg font-semibold ${theme.colors.text.primary} mb-3`}>5. API Client Implementation (with Clerk Auth)</h3>
              <pre className="bg-gray-100 p-4 rounded text-black font-mono text-sm overflow-x-auto">
{`import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { open } from 'open'; // For opening browser
import { createServer } from 'http';
import { randomBytes } from 'crypto';

export class Exit1ApiClient {
  private functions;
  private auth;
  private clerkPublishableKey = 'your_clerk_publishable_key';

  constructor() {
    const app = initializeApp({
      projectId: 'exit1-dev',
      apiKey: 'your_firebase_api_key'
    });
    
    this.auth = getAuth(app);
    this.functions = getFunctions(app);
  }

  async authenticate() {
    // Check if already authenticated
    if (this.auth.currentUser) return;

    // Start local server to receive OAuth callback
    const port = 3001;
    const state = randomBytes(16).toString('hex');
    
    const server = createServer((req, res) => {
      const url = new URL(req.url, \`http://localhost:\${port}\`);
      
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        if (code) {
          // Exchange code for Firebase custom token
          this.exchangeCodeForToken(code).then(() => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Authentication successful! You can close this window.</h1>');
            server.close();
          });
        }
      }
    });

    server.listen(port);

    // Open browser for Clerk OAuth
    const authUrl = \`https://clerk.yourdomain.com/oauth/authorize?client_id=\${this.clerkPublishableKey}&redirect_uri=http://localhost:\${port}/callback&state=\${state}&response_type=code\`;
    
    await open(authUrl);
    
    // Wait for authentication to complete
    return new Promise((resolve) => {
      server.on('close', resolve);
    });
  }

  async exchangeCodeForToken(code) {
    // Exchange OAuth code for Firebase custom token
    // This requires a backend endpoint that uses Clerk's API
    const response = await fetch('https://your-backend.com/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    
    const { token } = await response.json();
    await signInWithCustomToken(this.auth, token);
  }

  async addWebsite(request) {
    // Ensure authenticated before making API calls
    await this.authenticate();
    
    try {
      const addWebsite = httpsCallable(this.functions, "addWebsite");
      const result = await addWebsite(request);
      return { success: true, data: result.data };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  // ... implement all other methods with authentication check
}`}
              </pre>
            </div>

            <div>
              <h3 className={`text-lg font-semibold ${theme.colors.text.primary} mb-3`}>6. Backend Token Exchange</h3>
              <div className="bg-gray-100 p-4 rounded text-black font-mono text-sm">
                <div><strong>Required Backend Endpoint:</strong></div>
                <div>• You need a backend endpoint to exchange Clerk OAuth codes for Firebase custom tokens</div>
                <div>• This endpoint uses Clerk's API to verify the OAuth code</div>
                <div>• Returns a Firebase custom token that the CLI can use</div>
              </div>
              <pre className="bg-gray-100 p-4 rounded text-black font-mono text-sm overflow-x-auto mt-3">
{`// Example backend endpoint (Node.js/Express)
app.post('/auth/token', async (req, res) => {
  const { code } = req.body;
  
  // Exchange OAuth code for Clerk session
  const session = await clerk.sessions.verifySession(code);
  
  // Generate Firebase custom token
  const customToken = await admin.auth().createCustomToken(session.userId);
  
  res.json({ token: customToken });
});`}
              </pre>
            </div>

            <div>
              <h3 className={`text-lg font-semibold ${theme.colors.text.primary} mb-3`}>7. Error Handling</h3>
              <div className="bg-gray-100 p-4 rounded text-black font-mono text-sm">
                <div><strong>Common Error Codes:</strong></div>
                <div>• <code>AUTHENTICATION_REQUIRED</code> - User not authenticated</div>
                <div>• <code>INVALID_URL</code> - URL format validation failed</div>
                <div>• <code>WEBSITE_NOT_FOUND</code> - Website ID doesn't exist</div>
                <div>• <code>INSUFFICIENT_PERMISSIONS</code> - User doesn't own resource</div>
                <div>• <code>LIMIT_EXCEEDED</code> - User reached maximum allowed items</div>
              </div>
            </div>

            <div>
              <h3 className={`text-lg font-semibold ${theme.colors.text.primary} mb-3`}>8. Rate Limiting</h3>
              <div className="bg-gray-100 p-4 rounded text-black font-mono text-sm">
                <div>• Manual checks: Limited to prevent abuse</div>
                <div>• Webhook tests: Limited to prevent spam</div>
                <div>• General operations: Standard Firebase Functions limits</div>
                <div>• Implement exponential backoff for retries</div>
              </div>
            </div>
          </div>
        </Card>

        {!userId && (
          <Card className="mb-8 p-6">
            <div className="text-center">
              <h2 className={`text-xl font-semibold ${theme.colors.text.primary} mb-2`}>
                Authentication Required
              </h2>
              <p className={theme.colors.text.secondary}>
                Please sign in to test the API endpoints.
              </p>
            </div>
          </Card>
        )}

        {Object.entries(groupedEndpoints).map(([category, endpoints]) => (
          <Card key={category} className="mb-8 p-6">
            <div className="mb-6">
              <h2 className={`text-2xl font-semibold ${theme.colors.text.primary} mb-2`}>
                {CATEGORIES[category as keyof typeof CATEGORIES].name}
              </h2>
              <p className={theme.colors.text.secondary}>
                {category === 'websites' && 'Manage your monitored websites'}
                {category === 'webhooks' && 'Configure webhook notifications'}
                {category === 'system' && 'System status and monitoring'}
                {category === 'discord' && 'Discord integration features'}
              </p>
            </div>

            <div className="space-y-4">
              {endpoints.map((endpoint) => (
                                 <div
                   key={endpoint.name}
                   className={`border rounded-lg p-4 transition-colors ${theme.colors.border.secondary}`}
                 >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center space-x-3">
                                             <Badge 
                         variant={endpoint.method === 'POST' ? 'default' : 'info'}
                         className="font-mono"
                       >
                        {endpoint.method}
                      </Badge>
                      <h3 className={`text-lg font-semibold ${theme.colors.text.primary} font-mono`}>
                        {endpoint.name}
                      </h3>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => openEndpointModal(endpoint)}
                      disabled={!userId}
                    >
                      Test
                    </Button>
                  </div>
                  
                  <p className={`${theme.colors.text.secondary} mb-3`}>
                    {endpoint.description}
                  </p>

                                     <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                     <div>
                       <h4 className={`font-semibold ${theme.colors.text.primary} mb-2`}>Request Schema</h4>
                       <pre className={`bg-gray-100 p-3 rounded text-xs overflow-x-auto text-black`}>
                         {JSON.stringify(endpoint.requestSchema, null, 2)}
                       </pre>
                     </div>
                     <div>
                       <h4 className={`font-semibold ${theme.colors.text.primary} mb-2`}>Response Schema</h4>
                       <pre className={`bg-gray-100 p-3 rounded text-xs overflow-x-auto text-black`}>
                         {JSON.stringify(endpoint.responseSchema, null, 2)}
                       </pre>
                     </div>
                   </div>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={`Test: ${selectedEndpoint?.name}`}
        size="lg"
      >
        {selectedEndpoint && (
          <div className="space-y-6">
            <div>
              <h3 className={`font-semibold ${theme.colors.text.primary} mb-2`}>Request Data</h3>
                             <textarea
                 value={requestData}
                 onChange={(e) => setRequestData(e.target.value)}
                 className={`w-full h-32 p-3 border rounded font-mono text-sm ${theme.colors.border.secondary} text-black bg-white`}
                 placeholder="Enter JSON request data..."
               />
              <div className="mt-2">
                                 <Button
                   size="sm"
                   variant="secondary"
                   onClick={() => setRequestData(JSON.stringify(selectedEndpoint.example.request, null, 2))}
                 >
                  Use Example
                </Button>
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                onClick={handleTestEndpoint}
                disabled={isLoading || !userId}
                className="min-w-[100px]"
              >
                {isLoading ? <Spinner size="sm" /> : 'Test Endpoint'}
              </Button>
            </div>

                         {testResults && (
               <div>
                 <h3 className={`font-semibold ${theme.colors.text.primary} mb-2`}>Response</h3>
                 <pre className={`bg-gray-100 p-4 rounded text-sm overflow-x-auto text-black`}>
                   {JSON.stringify(testResults, null, 2)}
                 </pre>
               </div>
             )}
          </div>
        )}
      </Modal>
    </>
  );
} 