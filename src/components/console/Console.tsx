import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useConsoleState } from '../../hooks/useConsoleState';
import { useMobile } from '../../hooks/useMobile';
import { createCommands } from './ConsoleCommands';
import ConsoleWindow from './ConsoleWindow';
import ConsoleInput from './ConsoleInput';
import type { Website } from '../../types';

interface ConsoleProps {
  logs: string[];
  websites?: Website[];
  onAddWebsite?: (name: string, url: string) => Promise<void>;
  onEditWebsite?: (id: string, name: string, url: string) => Promise<void>;
  onDeleteWebsite?: (id: string) => Promise<void>;
}

const Console: React.FC<ConsoleProps> = React.memo(({ 
  logs, 
  websites = [], 
  onAddWebsite, 
  onEditWebsite, 
  onDeleteWebsite
}) => {
  const {
    position,
    size,
    isMinimized,
    isMaximized,
    updateState
  } = useConsoleState();

  const isMobile = useMobile();
  const [prevPosition, setPrevPosition] = useState(position);

  // Helper function to calculate maximized dimensions accounting for mobile navigation
  const getMaximizedDimensions = useCallback(() => {
    const maxWidth = window.innerWidth * 0.94;
    let maxHeight = window.innerHeight * 0.90;
    
    // On mobile, account for the bottom navigation bar (80px = h-20)
    if (isMobile) {
      maxHeight = (window.innerHeight - 80) * 0.90;
    }
    
    return { maxWidth, maxHeight };
  }, [isMobile]);
  const [inputValue, setInputValue] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [consoleOutput, setConsoleOutput] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  
  const outputRef = useRef<HTMLDivElement>(null);

  // Memoize commands to prevent recreation on each render
  const commands = useMemo(() => createCommands({
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
  }), [websites, logs, consoleOutput, size, position, isMaximized, isMinimized, commandHistory, onAddWebsite, onEditWebsite, onDeleteWebsite]);

  // Execute command logic
  const executeCommand = useCallback(async (commandLine: string) => {
    const trimmed = commandLine.trim();
    if (!trimmed) return;

    setCommandHistory(prev => [...prev, trimmed]);
    setHistoryIndex(-1);

    const parts = trimmed.split(' ');
    const commandName = parts[0].toLowerCase();
    const args = parts.slice(1);

    setConsoleOutput(prev => [...prev, `$ ${trimmed}`]);

    const command = commands[commandName];
    if (command) {
      try {
        const result = await command.execute(args);
        if (Array.isArray(result)) {
          setConsoleOutput(prev => [...prev, ...result]);
        } else {
          setConsoleOutput(prev => [...prev, result]);
        }
      } catch (error) {
        setConsoleOutput(prev => [...prev, `Error executing command: ${error}`]);
      }
    } else {
      setConsoleOutput(prev => [...prev, `Command not found: ${commandName}. Type 'help' for available commands.`]);
    }
  }, [commands]);

  const handleInputSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim()) {
      await executeCommand(inputValue);
      setInputValue('');
    }
  }, [inputValue, executeCommand]);

  const handleMaximizeToggle = useCallback(() => {
    if (isMaximized) {
      if (isMobile) {
        // On mobile, when maximized, clicking maximize should minimize (no windowed state)
        updateState({ isMaximized: false, isMinimized: true });
      } else {
        // On desktop, when maximized, clicking maximize should restore to windowed state
        updateState({ 
          isMaximized: false,
          size: { width: 600, height: 200 },
          position: prevPosition
        });
      }
    } else {
      setPrevPosition(position);
      const { maxWidth, maxHeight } = getMaximizedDimensions();
      updateState({
        isMaximized: true,
        isMinimized: false,
        size: { width: maxWidth, height: maxHeight },
        position: { 
          x: (window.innerWidth - maxWidth) / 2, 
          y: (window.innerHeight - maxHeight) / 2 
        }
      });
    }
  }, [isMaximized, position, prevPosition, isMobile, updateState, getMaximizedDimensions]);

  const handleMinimize = useCallback(() => {
    if (isMobile) {
      // On mobile, skip the windowed state - toggle directly between minimized and maximized
      if (isMinimized) {
        // If minimized, go to maximized
        const { maxWidth, maxHeight } = getMaximizedDimensions();
        updateState({
          isMinimized: false,
          isMaximized: true,
          size: { width: maxWidth, height: maxHeight },
          position: { 
            x: (window.innerWidth - maxWidth) / 2, 
            y: (window.innerHeight - maxHeight) / 2 
          }
        });
      } else {
        // If not minimized (maximized), go to minimized
        updateState({ isMinimized: true, isMaximized: false });
      }
    } else {
      // On desktop, use the original behavior (toggle windowed/minimized)
      updateState({ isMinimized: !isMinimized });
    }
  }, [isMinimized, isMaximized, isMobile, updateState, getMaximizedDimensions]);

  const handlePositionChange = useCallback((newPosition: { x: number; y: number }) => {
    updateState({ position: newPosition });
  }, [updateState]);

  const handleSizeChange = useCallback((newSize: { width: number; height: number }) => {
    updateState({ size: newSize });
  }, [updateState]);

  // Memoize log count to prevent unnecessary recalculations
  const logCount = useMemo(() => logs.length + consoleOutput.length, [logs.length, consoleOutput.length]);

  // Auto-scroll to bottom when output changes
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [consoleOutput, logs]);

  // Handle window resize for maximized mode
  useEffect(() => {
    const handleWindowResize = () => {
      if (isMaximized) {
        const { maxWidth, maxHeight } = getMaximizedDimensions();
        updateState({
          size: { width: maxWidth, height: maxHeight },
          position: { 
            x: (window.innerWidth - maxWidth) / 2, 
            y: (window.innerHeight - maxHeight) / 2 
          }
        });
      }
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [isMaximized, updateState, getMaximizedDimensions]);

  // Handle context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    
    if (selectedText) {
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        text: selectedText
      });
    }
  }, []);

  const handleCopyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setContextMenu(null);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  }, []);

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [contextMenu]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+A to select all text in console
      if (e.ctrlKey && e.key === 'a' && outputRef.current?.contains(e.target as Node)) {
        e.preventDefault();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(outputRef.current);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <ConsoleWindow
      position={position}
      size={size}
      isMinimized={isMinimized}
      isMaximized={isMaximized}
      onPositionChange={handlePositionChange}
      onSizeChange={handleSizeChange}
      onMaximizeToggle={handleMaximizeToggle}
      onMinimize={handleMinimize}
      logCount={logCount}
    >
      <div 
        ref={outputRef} 
        className="flex-1 overflow-y-auto p-3 space-y-1 select-text cursor-text console-output"
        onContextMenu={handleContextMenu}
      >
        {/* Original logs */}
        {logs.map((log, index) => (
          <div key={`log-${index}`} className="text-xs font-mono opacity-60 select-text">
            {log}
          </div>
        ))}
        
        {/* Console output */}
        {consoleOutput.map((output, index) => (
          <div key={`output-${index}`} className="text-xs font-mono select-text">
            {output}
          </div>
        ))}
        
        {/* Welcome message if no output */}
        {consoleOutput.length === 0 && logs.length === 0 && (
          <div className="text-xs opacity-60 italic">
            Welcome to the interactive console! Type 'help' to see available commands.
            <br />
            <span className="text-xs opacity-40">💡 Tip: You can select and copy text from the console output</span>
            <br />
            <span className="text-xs opacity-40">⌨️ Shortcuts: Ctrl+A to select all, right-click for context menu</span>
          </div>
        )}
      </div>
      
      <ConsoleInput
        inputValue={inputValue}
        setInputValue={setInputValue}
        commandHistory={commandHistory}
        historyIndex={historyIndex}
        setHistoryIndex={setHistoryIndex}
        onSubmit={handleInputSubmit}
        isMinimized={isMinimized}
      />
      
      {/* Context Menu */}
      {contextMenu && (
        <div 
          className="fixed z-[60] bg-black/95 border border-white rounded-lg shadow-lg min-w-[150px]"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            transform: 'translate(-50%, -100%)'
          }}
        >
          <button
            className="w-full text-left px-4 py-2 text-sm font-mono text-white hover:bg-white hover:text-black transition-colors rounded-t-lg"
            onClick={() => handleCopyToClipboard(contextMenu.text)}
          >
            📋 Copy "{contextMenu.text.length > 20 ? contextMenu.text.substring(0, 20) + '...' : contextMenu.text}"
          </button>
          <button
            className="w-full text-left px-4 py-2 text-sm font-mono text-white hover:bg-white hover:text-black transition-colors rounded-b-lg"
            onClick={() => setContextMenu(null)}
          >
            ❌ Cancel
          </button>
        </div>
      )}
    </ConsoleWindow>
  );
});

Console.displayName = 'Console';

export default Console; 