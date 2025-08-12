import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';
import { glass } from './glass';
import { ShieldCheck, AlertTriangle, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface SSLCertificate {
  valid: boolean;
  issuer?: string;
  subject?: string;
  validFrom?: number;
  validTo?: number;
  daysUntilExpiry?: number;
  lastChecked?: number;
  error?: string;
}

interface SSLTooltipProps {
  sslCertificate?: SSLCertificate;
  url: string;
  children: React.ReactNode;
}

const SSLTooltip: React.FC<SSLTooltipProps> = ({ sslCertificate, url, children }) => {
  const isHttps = url.startsWith('https://');

  const getGlassVariant = () => {
    if (!isHttps) return 'primary' as const;
    if (!sslCertificate) return 'primary' as const;
    const daysUntilExpiry = sslCertificate.daysUntilExpiry ?? undefined;
    if (!sslCertificate.valid) return 'destructive' as const;
    if (typeof daysUntilExpiry === 'number' && daysUntilExpiry <= 0) return 'destructive' as const;
    return 'primary' as const;
  };
  
  if (!isHttps) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {children}
        </TooltipTrigger>
        <TooltipContent className={`max-w-sm ${glass(getGlassVariant())}`}>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="rounded-md bg-sky-400/20 p-1.5">
                <ShieldCheck className="w-4 h-4 text-sky-200" />
              </div>
              <span className="font-semibold tracking-wide">HTTP Site</span>
            </div>
            <p className="text-[11px] leading-4 text-sky-100/80">
              This site uses HTTP and does not require SSL certificate validation.
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  if (!sslCertificate) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {children}
        </TooltipTrigger>
        <TooltipContent className={`max-w-sm ${glass(getGlassVariant())}`}>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="rounded-md bg-sky-400/20 p-1.5">
                <AlertTriangle className="w-4 h-4 text-sky-200" />
              </div>
              <span className="font-semibold tracking-wide">SSL Status Unknown</span>
            </div>
            <p className="text-[11px] leading-4 text-sky-100/80">
              SSL certificate information not available. The site may not have been checked yet.
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  const getStatusIcon = () => {
    if (!sslCertificate.valid) {
      return <AlertTriangle className="w-4 h-4 text-destructive" />;
    }
    
    const daysUntilExpiry = sslCertificate.daysUntilExpiry || 0;
    if (daysUntilExpiry <= 30) {
      return <Clock className="w-4 h-4 text-primary" />;
    }
    
    return <ShieldCheck className="w-4 h-4 text-primary" />;
  };

  const getStatusText = () => {
    if (!sslCertificate.valid) {
      return 'Invalid Certificate';
    }
    
    const daysUntilExpiry = sslCertificate.daysUntilExpiry || 0;
    if (daysUntilExpiry <= 0) {
      return 'Certificate Expired';
    } else if (daysUntilExpiry <= 30) {
      return `Expires in ${daysUntilExpiry} days`;
    }
    
    return 'Valid Certificate';
  };

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return 'Unknown';
    return new Date(timestamp).toLocaleDateString();
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {children}
      </TooltipTrigger>
      <TooltipContent className={`max-w-sm ${glass(getGlassVariant())}`}>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-sky-400/20 p-1.5">
              {getStatusIcon()}
            </div>
            <span className="font-semibold tracking-wide">{getStatusText()}</span>
          </div>

          <div className="space-y-2 text-[12px] leading-5">
            {sslCertificate.issuer && (
              <div>
                <div className="text-sky-100/70">Issuer</div>
                <div className="break-words">{sslCertificate.issuer}</div>
              </div>
            )}

            {sslCertificate.subject && (
              <div>
                <div className="text-sky-100/70">Subject</div>
                <div className="break-words">{sslCertificate.subject}</div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-sky-100/70">Valid From</div>
                <div>{formatDate(sslCertificate.validFrom)}</div>
              </div>
              <div>
                <div className="text-sky-100/70">Valid Until</div>
                <div>{formatDate(sslCertificate.validTo)}</div>
              </div>
            </div>

            {sslCertificate.daysUntilExpiry !== undefined && (
              <div>
                <div className="text-sky-100/70">Days Until Expiry</div>
                <div className={sslCertificate.daysUntilExpiry <= 30 ? 'text-yellow-200 font-semibold' : ''}>
                  {sslCertificate.daysUntilExpiry} days
                </div>
              </div>
            )}

            {sslCertificate.error && (
              <div>
                <div className="text-sky-100/70">Error</div>
                <div className="text-red-200">{sslCertificate.error}</div>
              </div>
            )}
          </div>

          {sslCertificate.lastChecked && (
            <div className="text-[11px] leading-4 text-sky-100/70 border-t border-sky-300/20 pt-2">
              Last checked {formatDistanceToNow(sslCertificate.lastChecked, { addSuffix: true })}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
};

export default SSLTooltip;
