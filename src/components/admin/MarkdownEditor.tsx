import React from 'react';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
  value,
  onChange,
  placeholder = 'Enter markdown content...',
  className = '',
}) => {
  return (
    <div className={`space-y-2 ${className}`}>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="min-h-[400px] font-mono text-sm"
          />
        </div>
        <div>
          <ScrollArea className="h-[400px] w-full rounded-md border bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40 border-sky-200/50 p-4">
            <div className="markdown-preview text-sm space-y-2">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                h1: ({node, ...props}) => <h1 className="text-2xl font-bold mb-2" {...props} />,
                h2: ({node, ...props}) => <h2 className="text-xl font-bold mb-2" {...props} />,
                h3: ({node, ...props}) => <h3 className="text-lg font-bold mb-2" {...props} />,
                p: ({node, ...props}) => <p className="mb-2 leading-relaxed" {...props} />,
                ul: ({node, ...props}) => <ul className="list-disc list-inside mb-2 space-y-1" {...props} />,
                ol: ({node, ...props}) => <ol className="list-decimal list-inside mb-2 space-y-1" {...props} />,
                li: ({node, ...props}) => <li className="ml-4" {...props} />,
                strong: ({node, ...props}) => <strong className="font-bold" {...props} />,
                em: ({node, ...props}) => <em className="italic" {...props} />,
                code: ({node, ...props}) => <code className="bg-muted px-1 py-0.5 rounded text-xs font-mono" {...props} />,
                a: ({node, ...props}) => <a className="text-primary underline hover:text-primary/80" {...props} />,
                blockquote: ({node, ...props}) => <blockquote className="border-l-4 border-primary pl-4 italic my-2" {...props} />,
              }}>
                {value || '*No content yet*'}
              </ReactMarkdown>
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
};

export default MarkdownEditor;

