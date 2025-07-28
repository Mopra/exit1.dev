import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useConsoleState } from '../../hooks/useConsoleState';
import { useMobile } from '../../hooks/useMobile';
import { createCommands } from './ConsoleCommands';
import ConsoleWindow from './ConsoleWindow';
import ConsoleInput from './ConsoleInput';
import { theme } from '../../config/theme';
import type { Website } from '../../types';

interface ConsoleProps {
  logs: string[];
  checks?: Website[];
  onAddCheck?: (name: string, url: string) => Promise<void>;
  onEditCheck?: (id: string, name: string, url: string) => Promise<void>;
  onDeleteCheck?: (id: string) => Promise<void>;
}

const Console: React.FC<ConsoleProps> = React.memo(({ 
  logs, 
  checks = [], 
  onAddCheck, 
  onEditCheck, 
  onDeleteCheck
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
    onDeleteCheck,
  }), [checks, logs, consoleOutput, size, position, isMaximized, isMinimized, commandHistory, onAddCheck, onEditCheck, onDeleteCheck]);

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
          size: { width: 800, height: 400 },
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
      inputArea={
        <ConsoleInput
          inputValue={inputValue}
          setInputValue={setInputValue}
          commandHistory={commandHistory}
          historyIndex={historyIndex}
          setHistoryIndex={setHistoryIndex}
          onSubmit={handleInputSubmit}
          isMinimized={isMinimized}
        />
      }
    >
      <div 
        ref={outputRef} 
        className={`flex-1 overflow-y-auto p-4 space-y-2 select-text cursor-text console-output ${theme.colors.text.console} min-h-0`}
        onContextMenu={handleContextMenu}
      >
        {/* Original logs */}
        {logs.map((log, index) => (
          <div key={`log-${index}`} className={`text-sm ${theme.typography.fontFamily.mono} opacity-70 select-text leading-relaxed`}>
            {log}
          </div>
        ))}
        
        {/* Console output */}
        {consoleOutput.map((output, index) => (
          <div key={`output-${index}`} className={`text-sm ${theme.typography.fontFamily.mono} select-text leading-relaxed`}>
            {output}
          </div>
        ))}
        
        {/* Welcome message if no output */}
        {consoleOutput.length === 0 && logs.length === 0 && (
          <div className={`text-sm opacity-70 italic ${theme.colors.text.muted} leading-relaxed space-y-2`}>
            <div>Welcome to the interactive console! Type 'help' to see available commands.</div>
            <div className={`text-sm opacity-50 ${theme.colors.text.muted} space-y-1`}>
              <div>💡 Tip: You can select and copy text from the console output</div>
              <div>⌨️ Shortcuts: Ctrl+A to select all, right-click for context menu</div>
            </div>
          </div>
        )}
      </div>
      
      {/* Context Menu */}
      {contextMenu && (
        <div 
          className={`fixed z-[55] ${theme.colors.background.modal} ${theme.borderRadius.lg} ${theme.shadows.lg} min-w-[150px]`}
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            transform: 'translate(-50%, -100%)'
          }}
        >
          <button
            className={`w-full text-left px-4 py-3 text-sm ${theme.typography.fontFamily.mono} ${theme.colors.text.primary} ${theme.colors.background.hover} ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${theme.borderRadius.lg === 'rounded-lg' ? 'rounded-t-lg' : ''} cursor-pointer`}
            onClick={() => handleCopyToClipboard(contextMenu.text)}
          >
            📋 Copy "{contextMenu.text.length > 20 ? contextMenu.text.substring(0, 20) + '...' : contextMenu.text}"
          </button>
          <button
            className={`w-full text-left px-4 py-3 text-sm ${theme.typography.fontFamily.mono} ${theme.colors.text.primary} ${theme.colors.background.hover} ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${theme.borderRadius.lg === 'rounded-lg' ? 'rounded-b-lg' : ''} cursor-pointer`}
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