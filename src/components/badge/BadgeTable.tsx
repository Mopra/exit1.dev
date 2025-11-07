import React from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '../ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { GlowCard } from '../ui';
import { ScrollArea } from '../ui/scroll-area';
import { useHorizontalScroll } from '../../hooks/useHorizontalScroll';
import type { Website } from '../../types';

interface BadgeTableProps {
  checks: Website[];
  embedType: 'inline' | 'container' | 'fixed';
  getEmbedCode: (checkId: string, type: 'inline' | 'container' | 'fixed') => string;
  onCopyCode: (checkId: string, type: 'inline' | 'container' | 'fixed') => void;
  copiedId: string | null;
  BadgePreview: React.FC<{ checkId: string }>;
}

const BadgeTable: React.FC<BadgeTableProps> = ({
  checks,
  embedType,
  getEmbedCode,
  onCopyCode,
  copiedId,
  BadgePreview
}) => {
  const { handleMouseDown: handleHorizontalScroll } = useHorizontalScroll();

  // Mobile Card Component
  const MobileBadgeCard = ({ check }: { check: Website }) => {
    const embedCode = getEmbedCode(check.id, embedType);
    const isCopied = copiedId === check.id;
    
    return (
      <div className="p-4 space-y-3">
        {/* Check Name and URL */}
        <div className="space-y-1">
          <div className="font-medium text-foreground">
            {check.name}
          </div>
          <div className="text-sm font-mono text-muted-foreground break-all">
            {check.url}
          </div>
        </div>

        {/* Preview */}
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground uppercase tracking-wider">Preview</span>
          <BadgePreview checkId={check.id} />
        </div>

        {/* Embed Code */}
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground uppercase tracking-wider">Embed Code</span>
          <code className="relative rounded bg-muted px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap block w-full">
            {embedCode}
          </code>
        </div>

        {/* Copy Button */}
        <Button
          variant="default"
          size="sm"
          onClick={() => onCopyCode(check.id, embedType)}
          className="w-full cursor-pointer"
        >
          {isCopied ? (
            <>
              <Check className="h-4 w-4 mr-2" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-4 w-4 mr-2" />
              Copy Code
            </>
          )}
        </Button>
      </div>
    );
  };

  return (
    <>
      {/* Mobile Card Layout */}
      <div className="block lg:hidden">
        <div className="space-y-3">
          {checks.map((check) => (
            <GlowCard key={check.id} className="p-0">
              <MobileBadgeCard check={check} />
            </GlowCard>
          ))}
        </div>
      </div>

      {/* Desktop Table Layout */}
      <div className="hidden lg:block w-full min-w-0">
        <GlowCard className="w-full min-w-0 overflow-hidden">
          <ScrollArea className="w-full min-w-0" onMouseDown={handleHorizontalScroll}>
            <div className="min-w-[1000px] w-full">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-4 py-4 text-md w-[280px]">Check Name</TableHead>
                    <TableHead className="px-4 py-4 text-md">Preview</TableHead>
                    <TableHead className="px-4 py-4 text-md">Embed Code</TableHead>
                    <TableHead className="px-4 py-4 text-md w-[120px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {checks.map((check) => {
                    const embedCode = getEmbedCode(check.id, embedType);
                    const isCopied = copiedId === check.id;
                    
                    return (
                      <TableRow key={check.id}>
                        <TableCell className="pl-4 py-4 pr-8 font-medium text-md">
                          <div className="flex flex-col gap-1">
                            <div className="break-words">{check.name}</div>
                            <div className="text-md text-muted-foreground font-normal break-all">{check.url}</div>
                          </div>
                        </TableCell>
                        <TableCell className="px-4 py-4">
                          <BadgePreview checkId={check.id} />
                        </TableCell>
                        <TableCell className="px-4 py-4">
                          <code className="relative rounded bg-muted px-[0.5rem] py-[0.3rem] font-mono text-md break-all whitespace-pre-wrap inline-block max-w-full">
                            {embedCode}
                          </code>
                        </TableCell>
                        <TableCell className="px-4 py-4">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onCopyCode(check.id, embedType)}
                            className="cursor-pointer"
                          >
                            {isCopied ? (
                              <>
                                <Check className="h-4 w-4 mr-2" />
                                Copied
                              </>
                            ) : (
                              <>
                                <Copy className="h-4 w-4 mr-2" />
                                Copy
                              </>
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </ScrollArea>
        </GlowCard>
      </div>
    </>
  );
};

export default BadgeTable;

