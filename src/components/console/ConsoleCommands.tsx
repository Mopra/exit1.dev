import { testConsoleStorage, clearConsoleStorage, getConsoleStorageInfo } from '../../utils/consoleStorageTest';
import type { Website } from '../../types';

export interface Command {
  name: string;
  description: string;
  execute: (args: string[]) => string | string[] | Promise<string | string[]>;
}

interface CreateCommandsProps {
  websites: Website[];
  logs: string[];
  consoleOutput: string[];
  size: { width: number; height: number };
  position: { x: number; y: number };
  isMaximized: boolean;
  isMinimized: boolean;
  commandHistory: string[];
  setConsoleOutput: React.Dispatch<React.SetStateAction<string[]>>;
  onAddWebsite?: (name: string, url: string) => Promise<void>;
  onEditWebsite?: (id: string, name: string, url: string) => Promise<void>;
  onDeleteWebsite?: (id: string) => Promise<void>;
}

export const createCommands = ({
  websites,
  logs,
  consoleOutput,
  size,
  position,
  isMaximized,
  isMinimized,
  commandHistory,
  setConsoleOutput,
  onAddWebsite,
  onEditWebsite,
  onDeleteWebsite,
}: CreateCommandsProps): Record<string, Command> => {
  const commands: Record<string, Command> = {
    help: {
      name: 'help',
      description: 'Show available commands',
      execute: async (args) => {
        if (args.length > 0) {
          const commandName = args[0].toLowerCase();
          const command = commands[commandName];
          if (command) {
            const result = await command.execute(args);
            return Array.isArray(result) ? result : [result];
          } else {
            return [`Command '${commandName}' not found. Type 'help' to see all available commands.`];
          }
        }
        
        const commandList = Object.values(commands).map(cmd => 
          `${cmd.name.padEnd(12)} - ${cmd.description}`
        );
        return [
          'Available commands:',
          '',
          ...commandList,
          '',
          'Type "help [command]" for detailed information about a specific command.',
          'Use arrow keys to navigate command history.'
        ];
      }
    },
    
    clear: {
      name: 'clear',
      description: 'Clear console output',
      execute: async () => {
        setConsoleOutput([]);
        return 'Console cleared.';
      }
    },
    
    echo: {
      name: 'echo',
      description: 'Print text to console',
      execute: async (args) => args.join(' ') || 'No text provided.'
    },
    
    date: {
      name: 'date',
      description: 'Show current date and time',
      execute: async () => new Date().toLocaleString()
    },
    
    status: {
      name: 'status',
      description: 'Show system status',
      execute: async () => [
        'System Status:',
        `- Console logs: ${logs.length}`,
        `- Console output: ${consoleOutput.length} lines`,
        `- Window size: ${size.width}x${size.height}`,
        `- Position: (${Math.round(position.x)}, ${Math.round(position.y)})`,
        `- Maximized: ${isMaximized ? 'Yes' : 'No'}`,
        `- Minimized: ${isMinimized ? 'Yes' : 'No'}`
      ]
    },
    
    ls: {
      name: 'ls',
      description: 'List available commands (alias for help)',
      execute: async () => commands.help.execute([])
    },
    
    whoami: {
      name: 'whoami',
      description: 'Show current user info',
      execute: async () => 'Console User - Interactive Terminal Session'
    },
    
    info: {
      name: 'info',
      description: 'Show detailed information',
      execute: async (args) => {
        if (args.length > 0) {
          const searchTerm = args[0];
          let website = websites.find(w => w.id === searchTerm);
          
          if (!website) {
            website = websites.find(w => 
              w.name.toLowerCase().includes(searchTerm.toLowerCase())
            );
          }
          
          if (!website) {
            return `Website with ID or name "${searchTerm}" not found.`;
          }
          
          const lastChecked = website.lastChecked 
            ? new Date(website.lastChecked).toLocaleString()
            : 'Never';
          return [
            `Website Information:`,
            `ID: ${website.id}`,
            `Name: ${website.name}`,
            `URL: ${website.url}`,
            `Status: ${website.status || 'unknown'}`,
            `Last Checked: ${lastChecked}`,
            `Created: ${website.id}`
          ];
        }
        
        return [
          'Console Information:',
          `- Version: 1.0.0`,
          `- Type: Interactive Terminal`,
          `- Commands available: ${Object.keys(commands).length}`,
          `- Command history: ${commandHistory.length} entries`,
          `- Websites monitored: ${websites.length}`,
          `- Auto-scroll: Enabled`,
          `- Draggable: ${!isMaximized ? 'Yes' : 'No'}`,
          `- Resizable: ${!isMaximized ? 'Yes' : 'No'}`,
          '',
          'Navigation:',
          '- Use ↑/↓ arrow keys to browse command history',
          '- Press Enter to execute commands',
          '- Type "help" for command list',
          '- Type "help [command]" for detailed help',
          '- Type "websites" for website management commands'
        ];
      }
    },
    
    version: {
      name: 'version',
      description: 'Show console version',
      execute: async () => 'Console v1.0.0 - Interactive Terminal'
    },
    
    history: {
      name: 'history',
      description: 'Show command history',
      execute: async () => {
        if (commandHistory.length === 0) {
          return 'No commands in history.';
        }
        return [
          'Command History:',
          '',
          ...commandHistory.map((cmd, index) => `${index + 1}: ${cmd}`)
        ];
      }
    },

    websites: {
      name: 'websites',
      description: 'Website management commands',
      execute: async (args) => {
        const subcommand = args[0]?.toLowerCase();
        
        switch (subcommand) {
          case 'list':
            if (websites.length === 0) {
              return 'No websites are currently being monitored.';
            }
            return [
              'Monitored Websites:',
              '',
              ...websites.map(w => `${w.id}: ${w.name} (${w.url}) - ${w.status || 'unknown'}`)
            ];
            
          case 'add':
            if (!onAddWebsite) {
              return 'Website management not available in this context.';
            }
            if (args.length < 3) {
              return 'Usage: websites add <name> <url>';
            }
            try {
              await onAddWebsite(args[1], args[2]);
              return `Website "${args[1]}" added successfully.`;
            } catch (error) {
              return `Failed to add website: ${error}`;
            }
            
          case 'edit':
            if (!onEditWebsite) {
              return 'Website management not available in this context.';
            }
            if (args.length < 4) {
              return 'Usage: websites edit <id> <name> <url>';
            }
            try {
              await onEditWebsite(args[1], args[2], args[3]);
              return `Website "${args[1]}" updated successfully.`;
            } catch (error) {
              return `Failed to update website: ${error}`;
            }
            
          case 'delete':
            if (!onDeleteWebsite) {
              return 'Website management not available in this context.';
            }
            if (args.length < 2) {
              return 'Usage: websites delete <id>';
            }
            try {
              await onDeleteWebsite(args[1]);
              return `Website "${args[1]}" deleted successfully.`;
            } catch (error) {
              return `Failed to delete website: ${error}`;
            }
            
          default:
            return [
              'Website Management Commands:',
              '',
              'websites list           - List all monitored websites',
              'websites add <name> <url> - Add a new website',
              'websites edit <id> <name> <url> - Edit a website',
              'websites delete <id>    - Delete a website',
              '',
              'Examples:',
              '  websites list',
              '  websites add "My Site" https://example.com',
              '  websites edit abc123 "Updated Name" https://new-url.com',
              '  websites delete abc123'
            ];
        }
      }
    },

    storage: {
      name: 'storage',
      description: 'Console storage management',
      execute: async (args) => {
        const subcommand = args[0]?.toLowerCase();
        
        switch (subcommand) {
          case 'test':
            try {
              await testConsoleStorage();
              return 'Storage test completed successfully.';
            } catch (error) {
              return `Storage test failed: ${error}`;
            }
            
          case 'clear':
            try {
              await clearConsoleStorage();
              return 'Console storage cleared successfully.';
            } catch (error) {
              return `Failed to clear storage: ${error}`;
            }
            
          case 'info':
            try {
              const info = await getConsoleStorageInfo();
              if (info.exists) {
                return [
                  'Storage Information:',
                  `- Data exists: Yes`,
                  `- Size: ${info.size} characters`,
                  `- Type: localStorage`,
                  `- Content: ${JSON.stringify(info.data, null, 2)}`
                ];
              } else {
                return [
                  'Storage Information:',
                  `- Data exists: No`,
                  `- Error: ${info.error || 'No data stored'}`,
                  `- Type: localStorage`
                ];
              }
            } catch (error) {
              return `Failed to get storage info: ${error}`;
            }
            
          default:
            return [
              'Storage Management Commands:',
              '',
              'storage test    - Test storage functionality',
              'storage clear   - Clear console storage',
              'storage info    - Show storage information'
            ];
        }
      }
    }
  };

  return commands;
}; 