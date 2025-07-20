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
    <div className={`border-t ${theme.colors.border.console} p-2`}>
      <form onSubmit={onSubmit} className="flex items-center gap-2 w-full">
        <span className={`${theme.colors.text.console} text-xs flex-shrink-0`}>$</span>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          className={`flex-1 bg-transparent ${theme.colors.text.console} text-xs border-none p-0 min-w-0 outline-none`}
          placeholder="Type a command..."
          autoComplete="off"
          aria-label="Console command input"
        />
      </form>
    </div>
  );
});

ConsoleInput.displayName = 'ConsoleInput';

export default ConsoleInput; 