// src/components/check/BadgeEmbed.tsx

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '../ui';
import { copyToClipboard } from '../../utils/clipboard';
import { toast } from 'sonner';

type BadgeVariant = 'status' | 'uptime' | 'response';

const VARIANTS: { value: BadgeVariant; label: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'uptime', label: 'Uptime' },
  { value: 'response', label: 'Response' },
];

const BASE_URL = 'https://app.exit1.dev/v1/badge';
const LINK_URL = 'https://exit1.dev';

function getBadgeUrl(checkId: string, variant: BadgeVariant): string {
  return `${BASE_URL}/${checkId}?type=${variant}`;
}

function getMarkdownSnippet(checkId: string, variant: BadgeVariant): string {
  const url = getBadgeUrl(checkId, variant);
  return `[![exit1 ${variant}](${url})](${LINK_URL})`;
}

function getHtmlSnippet(checkId: string, variant: BadgeVariant): string {
  const url = getBadgeUrl(checkId, variant);
  return `<a href="${LINK_URL}"><img src="${url}" alt="exit1 ${variant}"></a>`;
}

type SnippetFormat = 'markdown' | 'html' | 'url';

const FORMATS: { value: SnippetFormat; label: string }[] = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'html', label: 'HTML' },
  { value: 'url', label: 'Image URL' },
];

export function BadgeEmbed({ checkId }: { checkId: string }) {
  const [variant, setVariant] = useState<BadgeVariant>('status');
  const [format, setFormat] = useState<SnippetFormat>('markdown');
  const [copied, setCopied] = useState(false);

  const snippet =
    format === 'markdown' ? getMarkdownSnippet(checkId, variant) :
    format === 'html' ? getHtmlSnippet(checkId, variant) :
    getBadgeUrl(checkId, variant);

  const handleCopy = async () => {
    const ok = await copyToClipboard(snippet);
    if (ok) {
      setCopied(true);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error('Failed to copy');
    }
  };

  return (
    <div className="space-y-4">
      {/* Live previews */}
      <div className="flex flex-wrap gap-3">
        {VARIANTS.map((v) => (
          <button
            key={v.value}
            type="button"
            onClick={() => setVariant(v.value)}
            className={`rounded-lg p-2 transition-colors ${
              variant === v.value
                ? 'bg-muted ring-1 ring-primary/30'
                : 'hover:bg-muted/50'
            }`}
          >
            <img
              src={getBadgeUrl(checkId, v.value)}
              alt={`exit1 ${v.label} badge`}
              height={24}
            />
          </button>
        ))}
      </div>

      {/* Format selector */}
      <div className="flex gap-1 rounded-lg bg-muted/30 p-1 w-fit">
        {FORMATS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFormat(f.value)}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              format === f.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Snippet + copy */}
      <div className="relative">
        <pre className="text-xs bg-muted/30 rounded-lg p-3 pr-12 overflow-x-auto border border-border/30">
          <code className="text-muted-foreground">{snippet}</code>
        </pre>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute top-2 right-2 h-7 w-7"
          onClick={handleCopy}
        >
          {copied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
        </Button>
      </div>
    </div>
  );
}
