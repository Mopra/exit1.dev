import type { Website } from '../../types';

interface CreateCommandsProps {
  checks: Website[];
  logs: string[];
  consoleOutput: string[];
  size: { width: number; height: number };
  position: { x: number; y: number };
  isMaximized: boolean;
  isMinimized: boolean;
  commandHistory: string[];
  setConsoleOutput: (output: string[] | ((prev: string[]) => string[])) => void;
  onAddCheck?: (name: string, url: string) => Promise<void>;
  onEditCheck?: (id: string, name: string, url: string) => Promise<void>;
  onDeleteCheck?: (id: string) => Promise<void>;
}

interface Command {
  name: string;
  description: string;
  execute: (args: string[]) => Promise<string | string[]>;
}

export const createCommands = ({
  checks,
  logs,
  consoleOutput,
  size,
  position,
  isMaximized,
  isMinimized,
  commandHistory,
  setConsoleOutput,
  onAddCheck,
  onEditCheck,
  onDeleteCheck
}: CreateCommandsProps) => {
  const commands: Record<string, Command> = {

    help: {
      name: 'help',
      description: 'Show available commands',
      execute: async (args) => {
        const commandName = args[0];
        if (commandName) {
          const command = commands[commandName.toLowerCase()];
          if (command) {
            return [
              `Command: ${command.name}`,
              `Description: ${command.description}`,
              '',
              'Usage:',
              `  ${command.name} [arguments]`
            ];
          } else {
            return `Command '${commandName}' not found. Type 'help' for available commands.`;
          }
        }
        
        return [
          'Available Commands:',
          '',
          'System:',
          '  help                    - Show this help',
          '  clear                   - Clear console output',
          '  version                 - Show console version',
          '  history                 - Show command history',
          '',
          'Console:',
          '  minimize                - Minimize console window',
          '  maximize                - Maximize console window',
          '  reset                   - Reset console position and size',
          '  size <width> <height>   - Set console size',
          '  position <x> <y>        - Set console position',
          '',
          'Information:',
          '  logs                    - Show recent logs',
          '  output                  - Show console output',
          '  status                  - Show system status',
          '',
          'Check Management:',
          '  checks list             - List all monitored checks',
          '  checks add <name> <url> - Add a new check',
          '  checks edit <id> <name> <url> - Edit a check',
          '  checks delete <id>      - Delete a check',
          '',
          'Type "help <command>" for detailed information about a specific command.'
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

    logs: {
      name: 'logs',
      description: 'Show recent logs',
      execute: async () => {
        if (logs.length === 0) {
          return 'No logs available.';
        }
        return [
          'Recent Logs:',
          '',
          ...logs.slice(-20).map(log => `  ${log}`)
        ];
      }
    },

    output: {
      name: 'output',
      description: 'Show console output',
      execute: async () => {
        if (consoleOutput.length === 0) {
          return 'No console output available.';
        }
        return [
          'Console Output:',
          '',
          ...consoleOutput.slice(-20).map(line => `  ${line}`)
        ];
      }
    },

    status: {
      name: 'status',
      description: 'Show system status',
      execute: async () => {
        const activeChecks = checks.filter(check => !check.disabled);
        const onlineChecks = activeChecks.filter(check => check.status === 'online');
        const offlineChecks = activeChecks.filter(check => check.status === 'offline');
        
        return [
          'System Status:',
          '',
          `Total Checks: ${checks.length}`,
          `Active Checks: ${activeChecks.length}`,
          `Online: ${onlineChecks.length}`,
          `Offline: ${offlineChecks.length}`,
          `Disabled: ${checks.length - activeChecks.length}`,
          '',
          'Console:',
          `  Size: ${size.width}x${size.height}`,
          `  Position: (${position.x}, ${position.y})`,
          `  Maximized: ${isMaximized ? 'Yes' : 'No'}`,
          `  Minimized: ${isMinimized ? 'Yes' : 'No'}`,
          '',
          'Recent Activity:',
          `  Logs: ${logs.length} entries`,
          `  Output: ${consoleOutput.length} lines`,
          `  Commands: ${commandHistory.length} executed`
        ];
      }
    },

    minimize: {
      name: 'minimize',
      description: 'Minimize console window',
      execute: async () => {
        // This would be handled by the console state management
        return 'Console minimized.';
      }
    },

    maximize: {
      name: 'maximize',
      description: 'Maximize console window',
      execute: async () => {
        // This would be handled by the console state management
        return 'Console maximized.';
      }
    },

    reset: {
      name: 'reset',
      description: 'Reset console position and size',
      execute: async () => {
        // This would be handled by the console state management
        return 'Console reset to default position and size.';
      }
    },

    size: {
      name: 'size',
      description: 'Set console size',
      execute: async (args) => {
        if (args.length < 2) {
          return 'Usage: size <width> <height>';
        }
        const width = parseInt(args[0]);
        const height = parseInt(args[1]);
        
        if (isNaN(width) || isNaN(height)) {
          return 'Invalid size values. Please provide numbers.';
        }
        
        // This would be handled by the console state management
        return `Console size set to ${width}x${height}.`;
      }
    },

    position: {
      name: 'position',
      description: 'Set console position',
      execute: async (args) => {
        if (args.length < 2) {
          return 'Usage: position <x> <y>';
        }
        const x = parseInt(args[0]);
        const y = parseInt(args[1]);
        
        if (isNaN(x) || isNaN(y)) {
          return 'Invalid position values. Please provide numbers.';
        }
        
        // This would be handled by the console state management
        return `Console position set to (${x}, ${y}).`;
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

    checks: {
      name: 'checks',
      description: 'Check management commands',
      execute: async (args) => {
        const subcommand = args[0]?.toLowerCase();
        
        switch (subcommand) {
          case 'list':
            if (checks.length === 0) {
              return 'No checks are currently being monitored.';
            }
            return [
              'Monitored Checks:',
              '',
              ...checks.map(w => `${w.id}: ${w.name} (${w.url}) - ${w.status || 'unknown'}`)
            ];
            
          case 'add':
            if (!onAddCheck) {
              return 'Check management not available in this context.';
            }
            if (args.length < 3) {
              return 'Usage: checks add <name> <url>';
            }
            try {
              await onAddCheck(args[1], args[2]);
              return `Check "${args[1]}" added successfully.`;
            } catch (error) {
              return `Failed to add check: ${error}`;
            }
            
          case 'edit':
            if (!onEditCheck) {
              return 'Check management not available in this context.';
            }
            if (args.length < 4) {
              return 'Usage: checks edit <id> <name> <url>';
            }
            try {
              await onEditCheck(args[1], args[2], args[3]);
              return `Check "${args[1]}" updated successfully.`;
            } catch (error) {
              return `Failed to update check: ${error}`;
            }
            
          case 'delete':
            if (!onDeleteCheck) {
              return 'Check management not available in this context.';
            }
            if (args.length < 2) {
              return 'Usage: checks delete <id>';
            }
            try {
              await onDeleteCheck(args[1]);
              return `Check "${args[1]}" deleted successfully.`;
            } catch (error) {
              return `Failed to delete check: ${error}`;
            }
            
          default:
            return [
              'Check Management Commands:',
              '',
              'checks list           - List all monitored checks',
              'checks add <name> <url> - Add a new check',
              'checks edit <id> <name> <url> - Edit a check',
              'checks delete <id>    - Delete a check',
              '',
              'Examples:',
              '  checks list',
              '  checks add "My Site" https://example.com',
              '  checks edit abc123 "Updated Name" https://new-url.com',
              '  checks delete abc123'
            ];
        }
      }
    },
  };

  return commands;
}; 