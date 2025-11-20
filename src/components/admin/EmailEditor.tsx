import React, { useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Bold, Italic, List, ListOrdered, Link, Heading1, Heading2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmailEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

// Helper function to create email HTML with footer (matches backend createEmailHTML)
const createEmailHTMLWithFooter = (htmlContent: string, recipientEmail?: string): string => {
  const baseUrl = window.location.origin;
  const profileUrl = `${baseUrl}/profile`;
  const optOutUrl = recipientEmail 
    ? `${baseUrl}/opt-out?email=${encodeURIComponent(recipientEmail)}`
    : profileUrl;
  
  return `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        ${htmlContent}
        <div style="margin-top:32px;padding-top:20px;border-top:1px solid rgba(148,163,184,0.15);text-align:center;font-size:12px;color:rgba(226,232,240,0.6)">
          <p style="margin:0 0 8px 0;">Don't want to receive product updates?</p>
          <p style="margin:0;">
            <a href="${profileUrl}" style="color:rgba(148,163,184,0.8);text-decoration:underline;">Manage your email preferences</a> or <a href="${optOutUrl}" style="color:rgba(148,163,184,0.8);text-decoration:underline;">opt out</a>
          </p>
        </div>
      </div>
    </div>
  `;
};

const EmailEditor: React.FC<EmailEditorProps> = ({
  value,
  onChange,
  placeholder = 'Enter email content...',
  className = '',
}) => {
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== value) {
      editorRef.current.innerHTML = value || '';
    }
  }, [value]);

  const handleInput = () => {
    if (editorRef.current) {
      onChange(editorRef.current.innerHTML);
    }
  };

  const execCommand = (command: string, value?: string) => {
    document.execCommand(command, false, value);
    editorRef.current?.focus();
    handleInput();
  };

  const insertLink = () => {
    const url = prompt('Enter URL:');
    if (url) {
      execCommand('createLink', url);
    }
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-1 p-2 border rounded-md bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40 border-sky-200/50">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => execCommand('bold')}
          className="h-8 w-8 p-0 cursor-pointer"
          title="Bold"
        >
          <Bold className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => execCommand('italic')}
          className="h-8 w-8 p-0 cursor-pointer"
          title="Italic"
        >
          <Italic className="h-4 w-4" />
        </Button>
        <div className="h-6 w-px bg-border mx-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => execCommand('formatBlock', '<h1>')}
          className="h-8 w-8 p-0 cursor-pointer"
          title="Heading 1"
        >
          <Heading1 className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => execCommand('formatBlock', '<h2>')}
          className="h-8 w-8 p-0 cursor-pointer"
          title="Heading 2"
        >
          <Heading2 className="h-4 w-4" />
        </Button>
        <div className="h-6 w-px bg-border mx-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => execCommand('insertUnorderedList')}
          className="h-8 w-8 p-0 cursor-pointer"
          title="Bullet List"
        >
          <List className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => execCommand('insertOrderedList')}
          className="h-8 w-8 p-0 cursor-pointer"
          title="Numbered List"
        >
          <ListOrdered className="h-4 w-4" />
        </Button>
        <div className="h-6 w-px bg-border mx-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={insertLink}
          className="h-8 w-8 p-0 cursor-pointer"
          title="Insert Link"
        >
          <Link className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div
          ref={editorRef}
          contentEditable
          onInput={handleInput}
          className="min-h-[400px] w-full rounded-md border bg-background p-4 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 [&>h1]:text-2xl [&>h1]:font-bold [&>h1]:mb-2 [&>h2]:text-xl [&>h2]:font-bold [&>h2]:mb-2 [&>p]:mb-2 [&>ul]:list-disc [&>ul]:list-inside [&>ul]:mb-2 [&>ol]:list-decimal [&>ol]:list-inside [&>ol]:mb-2 [&>a]:text-primary [&>a]:underline"
          data-placeholder={placeholder}
          suppressContentEditableWarning
        />
        <ScrollArea className="h-[400px] w-full rounded-md border">
          <div
            dangerouslySetInnerHTML={{
              __html: value 
                ? createEmailHTMLWithFooter(value)
                : createEmailHTMLWithFooter('<p style="color:#94a3b8">Preview will appear here...</p>'),
            }}
          />
        </ScrollArea>
      </div>
      <style>{`
        [contenteditable][data-placeholder]:empty:before {
          content: attr(data-placeholder);
          color: hsl(var(--muted-foreground));
          pointer-events: none;
        }
      `}</style>
    </div>
  );
};

export default EmailEditor;

