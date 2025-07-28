import React, { useRef, useEffect, useCallback } from 'react';
import { theme } from '../../config/theme';

interface ConsoleInputProps {
  inputValue: string;
  setInputValue: (value: string) => void;
  commandHistory: string[];
  historyIndex: number;
  setHistoryIndex: (index: number) => void;
  onSubmit: (e: React.FormEvent) => void;
  isMinimized: boolean;
}

const ConsoleInput: React.FC<ConsoleInputProps> = React.memo(({
  inputValue,
  setInputValue,
  commandHistory,
  historyIndex,
  setHistoryIndex,
  onSubmit,
  isMinimized
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIndex < commandHistory.length - 1) {
        const newIndex = historyIndex + 1;
        setHistoryIndex(newIndex);
        setInputValue(commandHistory[commandHistory.length - 1 - newIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInputValue(commandHistory[commandHistory.length - 1 - newIndex]);
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setInputValue('');
      }
    }
  }, [historyIndex, commandHistory, setHistoryIndex, setInputValue]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  }, [setInputValue]);

  // Focus input when console is opened
  useEffect(() => {
    if (!isMinimized && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isMinimized]);

  return (
    <div className={`flex-shrink-0`}>
      <form onSubmit={onSubmit} className="flex items-center gap-3 w-full console-input">
        <span className={`${theme.colors.text.console} text-base font-medium flex-shrink-0`} aria-hidden="true">$</span>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          className={`flex-1 bg-neutral-900/50 backdrop-blur-sm ${theme.colors.text.console} text-base border border-neutral-700/50 px-3 py-2 min-w-0 outline-none placeholder:${theme.colors.text.muted} font-mono focus:border-neutral-400 focus:ring-2 focus:ring-neutral-400/20 focus:bg-neutral-900/70 transition-all duration-200 hover:border-neutral-600/50`}
          placeholder="Type a command..."
          autoComplete="off"
          spellCheck="false"
          aria-label="Console command input"
          aria-describedby="console-input-help"
          role="textbox"
          aria-multiline="false"
        />
      </form>
      <div id="console-input-help" className="text-xs text-neutral-500 mt-1 opacity-70 flex items-center gap-4">
        <span>Press Enter to execute</span>
        <span>↑↓ to navigate history</span>
        <span>Tab for autocomplete</span>
      </div>
    </div>
  );
});

ConsoleInput.displayName = 'ConsoleInput';

export default ConsoleInput; 