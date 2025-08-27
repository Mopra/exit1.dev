import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';
import { glass } from './glass';
import { Globe, AlertTriangle, Clock, Calendar, Info } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface DomainExpiry {
  valid: boolean;
  registrar?: string;
  domainName?: string;
  expiryDate?: number;
  daysUntilExpiry?: number;
  lastChecked?: number;
  error?: string;
  nameservers?: string[];
  hasDNSSEC?: boolean;
  status?: string[];
  events?: Array<{ action: string; date: string; actor?: string }>;
}

interface DomainExpiryTooltipProps {
  domainExpiry?: DomainExpiry;
  url: string;
  children: React.ReactNode;
}

const DomainExpiryTooltip: React.FC<DomainExpiryTooltipProps> = ({ domainExpiry, children }) => {
  const getStatusIcon = () => {
    if (!domainExpiry) return <Globe className="w-4 h-4 text-sky-200" />;
    if (!domainExpiry.valid) return <AlertTriangle className="w-4 h-4 text-red-200" />;
    if (domainExpiry.daysUntilExpiry !== undefined && domainExpiry.daysUntilExpiry <= 30) {
      return <Clock className="w-4 h-4 text-yellow-200" />;
    }
    // Check for RDAP data without expiry
    if (domainExpiry.registrar || domainExpiry.events?.length) {
      return <Globe className="w-4 h-4 text-green-200" />;
    }
    // Check for limited data status
    if (domainExpiry.error?.includes('Limited data available')) {
      return <Info className="w-4 h-4 text-blue-200" />;
    }
    return <Globe className="w-4 h-4 text-green-200" />;
  };

  const getStatusText = () => {
    if (!domainExpiry) return 'Domain Status Unknown';
    if (!domainExpiry.valid) return 'Domain Expired';
    if (domainExpiry.daysUntilExpiry !== undefined && domainExpiry.daysUntilExpiry <= 30) {
      return 'Domain Expiring Soon';
    }
    // Check for RDAP data without expiry
    if (domainExpiry.registrar || domainExpiry.events?.length) {
      return 'Domain Valid (RDAP Data)';
    }
    // Check for limited data status
    if (domainExpiry.error?.includes('Limited data available')) {
      return 'Domain Valid (Limited Data)';
    }
    return 'Domain Valid';
  };

  const getGlassVariant = () => {
    if (!domainExpiry) return 'primary' as const;
    if (!domainExpiry.valid) return 'destructive' as const;
    const daysUntilExpiry = domainExpiry.daysUntilExpiry ?? undefined;
    if (typeof daysUntilExpiry === 'number' && daysUntilExpiry <= 30) return 'warning' as const;
    // Check for RDAP data without expiry
    if (domainExpiry.registrar || domainExpiry.events?.length) return 'primary' as const;
    // Check for limited data status
    if (domainExpiry.error?.includes('Limited data available')) return 'muted' as const;
    return 'primary' as const;
  };

  const formatDate = (timestamp: number) => {
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
            {domainExpiry?.domainName && (
              <div>
                <div className="text-sky-100/70">Domain</div>
                <div className="break-words">{domainExpiry.domainName}</div>
              </div>
            )}

            {domainExpiry?.registrar && (
              <div>
                <div className="text-sky-100/70">Registrar</div>
                <div className="break-words">{domainExpiry.registrar}</div>
              </div>
            )}

            {domainExpiry?.nameservers && domainExpiry.nameservers.length > 0 && (
              <div>
                <div className="text-sky-100/70">Nameservers</div>
                <div className="space-y-1">
                  {domainExpiry.nameservers.slice(0, 3).map((ns, i) => (
                    <div key={i} className="text-xs break-words">{ns}</div>
                  ))}
                  {domainExpiry.nameservers.length > 3 && (
                    <div className="text-xs text-sky-100/50">+{domainExpiry.nameservers.length - 3} more</div>
                  )}
                </div>
              </div>
            )}

            {domainExpiry?.hasDNSSEC !== undefined && (
              <div>
                <div className="text-sky-100/70">DNSSEC</div>
                <div className={domainExpiry.hasDNSSEC ? 'text-green-200' : 'text-yellow-200'}>
                  {domainExpiry.hasDNSSEC ? 'Enabled' : 'Not enabled'}
                </div>
              </div>
            )}

            {domainExpiry?.events && domainExpiry.events.length > 0 && (
              <div>
                <div className="text-sky-100/70">Domain Events</div>
                <div className="space-y-1">
                  {domainExpiry.events.slice(0, 3).map((event, i) => (
                    <div key={i} className="text-xs">
                      <span className="text-sky-200">{event.action}</span>
                      {event.date && (
                        <span className="text-sky-100/50 ml-1">
                          {new Date(event.date).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  ))}
                  {domainExpiry.events.length > 3 && (
                    <div className="text-xs text-sky-100/50">+{domainExpiry.events.length - 3} more events</div>
                  )}
                </div>
              </div>
            )}

            {domainExpiry?.expiryDate && (
              <div>
                <div className="text-sky-100/70">Expiry Date</div>
                <div className="flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  {formatDate(domainExpiry.expiryDate)}
                </div>
              </div>
            )}

            {domainExpiry?.daysUntilExpiry !== undefined && (
              <div>
                <div className="text-sky-100/70">Days Until Expiry</div>
                <div className={domainExpiry.daysUntilExpiry <= 30 ? 'text-yellow-200 font-semibold' : ''}>
                  {domainExpiry.daysUntilExpiry} days
                </div>
              </div>
            )}

            {domainExpiry?.error && !domainExpiry.registrar && !domainExpiry.events?.length && (
              <div>
                <div className="text-sky-100/70">
                  {domainExpiry.error.includes('Limited data available') ? 'Note' : 'Error'}
                </div>
                <div className={domainExpiry.error.includes('Limited data available') ? 'text-blue-200' : 'text-red-200'}>
                  {domainExpiry.error}
                </div>
              </div>
            )}
          </div>

          {domainExpiry?.lastChecked && (
            <div className="text-[11px] leading-4 text-sky-100/70 border-t border-sky-300/20 pt-2">
              Last checked {formatDistanceToNow(domainExpiry.lastChecked, { addSuffix: true })}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
};

export default DomainExpiryTooltip;
