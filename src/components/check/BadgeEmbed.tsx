// src/components/check/BadgeEmbed.tsx

import { useState } from 'react';
import { Copy, Check, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../ui';
import { copyToClipboard } from '../../utils/clipboard';
import { toast } from 'sonner';

type BadgeVariant = 'status' | 'uptime' | 'response';

const VARIANTS: { value: BadgeVariant; label: string; description: string }[] = [
  { value: 'status', label: 'Status', description: 'Current up/down state' },
  { value: 'uptime', label: 'Uptime', description: 'Uptime percentage over 30 days' },
  { value: 'response', label: 'Response', description: 'Average response time' },
];

const BASE_URL = 'https://app.exit1.dev/v1/badge';
const LINK_URL = 'https://exit1.dev';

function getBadgeUrl(checkId: string, variant: BadgeVariant, hideBranding: boolean): string {
  const base = `${BASE_URL}/${checkId}?type=${variant}`;
  return hideBranding ? `${base}&branding=false` : base;
}

function getMarkdownSnippet(checkId: string, variant: BadgeVariant, checkName: string, hideBranding: boolean): string {
  const url = getBadgeUrl(checkId, variant, hideBranding);
  return `[![${checkName} ${variant}](${url})](${LINK_URL})`;
}

function getHtmlSnippet(checkId: string, variant: BadgeVariant, checkName: string, hideBranding: boolean): string {
  const url = getBadgeUrl(checkId, variant, hideBranding);
  return `<a href="${LINK_URL}"><img src="${url}" alt="${checkName} ${variant}"></a>`;
}

function getScriptSnippet(checkId: string, variant: BadgeVariant, hideBranding: boolean): string {
  const brandingStr = hideBranding ? '&branding=false' : '';
  return `<script src="${BASE_URL}/${checkId}/embed.js?type=${variant}${brandingStr}"></script>`;
}

type SnippetFormat = 'markdown' | 'html' | 'script';

const FORMATS: { value: SnippetFormat; label: string }[] = [
  { value: 'script', label: 'Script' },
  { value: 'html', label: 'HTML' },
  { value: 'markdown', label: 'Markdown' },
];

export function BadgeEmbed({ checkId, checkName, nano = false }: { checkId: string; checkName: string; nano?: boolean }) {
  const [variant, setVariant] = useState<BadgeVariant>('status');
  const [format, setFormat] = useState<SnippetFormat>('script');
  const [hideBranding, setHideBranding] = useState(false);
  const [copied, setCopied] = useState(false);

  const snippet =
    format === 'markdown' ? getMarkdownSnippet(checkId, variant, checkName, hideBranding) :
    format === 'html' ? getHtmlSnippet(checkId, variant, checkName, hideBranding) :
    getScriptSnippet(checkId, variant, hideBranding);

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
    <div className="space-y-3 min-w-0">
      {/* Live previews */}
      <div className="flex flex-col sm:flex-row gap-1.5">
        {VARIANTS.map((v) => (
          <button
            key={v.value}
            type="button"
            onClick={() => setVariant(v.value)}
            className={`flex flex-col items-start gap-2 sm:gap-0 rounded-lg p-3 transition-colors text-left flex-1 min-w-0 ${
              variant === v.value
                ? 'bg-white/10 ring-1 ring-white/20'
                : 'hover:bg-white/5'
            }`}
          >
            <img
              src={getBadgeUrl(checkId, v.value, hideBranding)}
              alt={`${checkName} ${v.label} badge`}
              height={24}
              className="max-w-full h-auto"
            />
            <p className="text-xs text-white/70 sm:mt-2">{v.description}</p>
          </button>
        ))}
      </div>

      {/* Branding toggle */}
      {nano ? (
        <div className="flex items-center justify-between">
          <span className="text-xs text-white/70">Hide exit1 branding</span>
          <button
            type="button"
            role="switch"
            aria-checked={hideBranding}
            onClick={() => setHideBranding(!hideBranding)}
            className={`relative w-8 h-[18px] rounded-full transition-colors cursor-pointer ${
              hideBranding ? 'bg-primary' : 'bg-white/20'
            }`}
          >
            <span className={`absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${
              hideBranding ? 'translate-x-[14px]' : ''
            }`} />
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-white/50">Hide exit1 branding</span>
            <button
              type="button"
              role="switch"
              aria-checked={false}
              disabled
              className="relative w-8 h-[18px] rounded-full bg-white/20 opacity-40 cursor-not-allowed"
            >
              <span className="absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white" />
            </button>
          </div>
          <Link to="/billing" className="flex items-center gap-1 text-[11px] text-tier-pro hover:text-tier-pro/80 transition-colors">
            <Sparkles className="w-3 h-3" />
            Upgrade to hide branding
          </Link>
        </div>
      )}

      {/* Format selector + copy */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1 rounded-lg bg-white/10 p-1">
          {FORMATS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFormat(f.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                format === f.value
                  ? 'bg-white/15 text-white shadow-sm'
                  : 'text-white/50 hover:text-white/80'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 bg-muted hover:bg-muted/80"
          onClick={handleCopy}
        >
          {copied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
        </Button>
      </div>

      {/* Snippet */}
      <pre className="text-xs bg-black/80 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all border border-white/40">
        <code className="text-white/80">{snippet}</code>
      </pre>
    </div>
  );
}
