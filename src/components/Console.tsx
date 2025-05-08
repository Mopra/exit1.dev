import React from 'react';

interface ConsoleProps {
  logs: string[];
}

const Console: React.FC<ConsoleProps> = ({ logs }) => {
  return (
    <div className="fixed bottom-0 left-0 w-full bg-gray-900 text-green-200 text-xs font-mono p-2 h-40 overflow-y-auto shadow-lg z-50 border-t border-gray-700">
      <div className="max-h-32 overflow-y-auto">
        {logs.length === 0 ? (
          <div className="text-gray-500">Console ready...</div>
        ) : (
          logs.map((log, idx) => (
            <div key={idx} className="whitespace-pre-wrap">{log}</div>
          ))
        )}
      </div>
    </div>
  );
};

export default Console; 