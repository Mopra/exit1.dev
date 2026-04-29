import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { useEffect } from 'react';
import { Button } from './Button';
import { cn } from '@/lib/utils';
import { Bold, Italic, List, Link as LinkIcon } from 'lucide-react';

interface RichTextEditorProps {
  content: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
}

export const RichTextEditor = ({ content, onChange, placeholder, className }: RichTextEditorProps) => {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: 'text-primary underline hover:text-primary/80',
        },
      }),
      Placeholder.configure({
        placeholder: placeholder || 'Enter notification message...',
      }),
    ],
    content,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class: cn(
          'prose prose-invert prose-sm max-w-none focus:outline-none min-h-[120px] p-3',
          'prose-headings:font-semibold prose-p:my-2 prose-ul:my-2 prose-li:my-0',
          'prose-a:text-primary prose-a:underline prose-a:no-underline hover:prose-a:underline',
          className
        ),
      },
    },
  });

  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content);
    }
  }, [content, editor]);

  if (!editor) {
    return null;
  }

  const addLink = () => {
    const url = window.prompt('Enter URL:');
    if (url) {
      editor.chain().focus().setLink({ href: url }).run();
    }
  };

  return (
    <div className="rounded-md border border-primary/20 bg-primary/10 backdrop-blur-sm">
      <div className="flex items-center gap-1 p-2 border-b border-primary/20">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-8 w-8 p-0 cursor-pointer",
            editor.isActive('bold') && "bg-primary/20"
          )}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-8 w-8 p-0 cursor-pointer",
            editor.isActive('italic') && "bg-primary/20"
          )}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-8 w-8 p-0 cursor-pointer",
            editor.isActive('bulletList') && "bg-primary/20"
          )}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List className="h-4 w-4" />
        </Button>
        <div className="w-px h-6 bg-primary/20 mx-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-8 w-8 p-0 cursor-pointer",
            editor.isActive('link') && "bg-primary/20"
          )}
          onClick={addLink}
        >
          <LinkIcon className="h-4 w-4" />
        </Button>
      </div>
      <EditorContent 
        editor={editor} 
        className={cn(
          "min-h-[120px] max-h-[300px] overflow-y-auto",
          "[&_.tiptap]:outline-none [&_.tiptap]:p-3",
          "[&_.tiptap_.is-empty:first-child::before]:content-[attr(data-placeholder)]",
          "[&_.tiptap_.is-empty:first-child::before]:text-primary/50",
          "[&_.tiptap_.is-empty:first-child::before]:float-left",
          "[&_.tiptap_.is-empty:first-child::before]:pointer-events-none",
          "[&_.tiptap_a]:text-primary [&_.tiptap_a]:underline [&_.tiptap_a]:cursor-pointer",
          "[&_.tiptap_a:hover]:text-primary/80",
          "[&_.tiptap-p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
          "[&_.tiptap-p.is-editor-empty:first-child::before]:text-primary/50"
        )}
      />
    </div>
  );
};

