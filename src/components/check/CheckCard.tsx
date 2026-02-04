import React from 'react';
import {
    MoreVertical,
    Folder,
    Play,
    Pause,
    Trash2,
    ExternalLink,
    Globe,
    Code,
    Server,
    Radio,
    ShieldCheck,
    AlertTriangle,
    Plus,
    Loader2,
    Edit,
    Clock,
    GripVertical
} from 'lucide-react';
import {
    IconButton,
    StatusBadge,
    Checkbox,
    SSLTooltip,
    Tooltip,
    TooltipTrigger,
    TooltipContent,
    Badge,
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubTrigger,
    DropdownMenuSubContent,
    glassClasses,
    Button,
    CHECK_INTERVALS,
    GlowCard
} from '../ui';
import type { Website } from '../../types';
import { cn } from "../../lib/utils";
import { formatLastChecked, formatResponseTime, highlightText } from '../../utils/formatters.tsx';

const getRegionLabel = (region?: Website['checkRegion']): { short: string; long: string } | null => {
    if (!region) return null;
    switch (region) {
        case 'us-central1':
            return { short: 'US-C', long: 'US Central (Iowa)' };
        case 'us-east4':
            return { short: 'US-E', long: 'US East (Virginia)' };
        case 'us-west1':
            return { short: 'US-W', long: 'US West (Oregon)' };
        case 'europe-west1':
            return { short: 'EU-BE', long: 'Europe (Belgium)' };
        case 'asia-southeast1':
            return { short: 'APAC', long: 'Asia Pacific (Singapore)' };
        default:
            return { short: String(region), long: String(region) };
    }
};

const getTypeIcon = (type?: string) => {
    switch (type) {
        case 'rest_endpoint':
            return <Code className="w-4 h-4 text-primary" />;
        case 'tcp':
            return <Server className="w-4 h-4 text-primary" />;
        case 'udp':
            return <Radio className="w-4 h-4 text-primary" />;
        default:
            return <Globe className="w-4 h-4 text-primary" />;
    }
};

const getTypeLabel = (type?: string) => {
    switch (type) {
        case 'rest_endpoint':
            return 'API';
        case 'tcp':
            return 'TCP';
        case 'udp':
            return 'UDP';
        default:
            return 'Website';
    }
};

const getSSLCertificateStatus = (check: Website) => {
    if (check.url.startsWith('tcp://')) {
        return { valid: true, icon: Server, color: 'text-muted-foreground', text: 'TCP' };
    }
    if (check.url.startsWith('udp://')) {
        return { valid: true, icon: Radio, color: 'text-muted-foreground', text: 'UDP' };
    }
    if (!check.url.startsWith('https://')) {
        return { valid: true, icon: ShieldCheck, color: 'text-muted-foreground', text: 'HTTP' };
    }

    if (!check.sslCertificate) {
        return { valid: false, icon: AlertTriangle, color: 'text-muted-foreground', text: 'Unknown' };
    }

    if (check.sslCertificate.valid) {
        const daysUntilExpiry = check.sslCertificate.daysUntilExpiry || 0;
        if (daysUntilExpiry <= 30) {
            return {
                valid: true,
                icon: AlertTriangle,
                color: 'text-primary',
                text: `${daysUntilExpiry} days`
            };
        }
        return {
            valid: true,
            icon: ShieldCheck,
            color: 'text-primary',
            text: 'Valid'
        };
    } else {
        return {
            valid: false,
            icon: AlertTriangle,
            color: 'text-destructive',
            text: 'Invalid'
        };
    }
};

const NeverCheckedOverlay: React.FC<{ onCheckNow: () => void }> = ({ onCheckNow }) => {
    return (
        <div className={`mt-1 ${glassClasses} rounded-md p-2 flex items-center justify-between`}>
            <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                </span>
                <Clock className="w-3 h-3 text-primary" />
                <span className="text-xs font-medium">In Queue</span>
            </div>
            <Button
                onClick={(e) => {
                    e.stopPropagation();
                    onCheckNow();
                }}
                size="sm"
                variant="ghost"
                className="text-xs h-7 px-2 cursor-pointer"
                aria-label="Check now"
            >
                Check Now
            </Button>
        </div>
    );
};

export interface CheckCardProps {
    check: Website;
    isSelected?: boolean;
    onSelect?: (id: string) => void;
    onCheckNow: (id: string) => void;
    onToggleStatus: (id: string, disabled: boolean) => void;
    onEdit: (check: Website) => void;
    onDelete: (check: Website) => void;
    onSetFolder?: (id: string, folder: string | null) => void | Promise<void>;
    openNewFolderDialog?: (check: Website) => void;
    isNano?: boolean;
    isOptimisticallyUpdating?: boolean;
    isFolderUpdating?: boolean;
    isManuallyChecking?: boolean;
    searchQuery?: string;
    folderOptions?: string[];
    hideCheckbox?: boolean;
    folderColor?: string;
    className?: string;
    showDragHandle?: boolean;
    draggable?: boolean;
    onDragStart?: (e: React.DragEvent) => void;
    onDragEnd?: (e: React.DragEvent) => void;
}

export const CheckCard: React.FC<CheckCardProps> = ({
    check,
    isSelected = false,
    onSelect,
    onCheckNow,
    onToggleStatus,
    onEdit,
    onDelete,
    onSetFolder,
    openNewFolderDialog,
    isNano: _isNano = false,
    isOptimisticallyUpdating = false,
    isFolderUpdating = false,
    isManuallyChecking = false,
    searchQuery = '',
    folderOptions = [],
    hideCheckbox = false,
    className,
    folderColor, // Optional custom color for folder badge
    showDragHandle = false,
    draggable = false,
    onDragStart,
    onDragEnd
}) => {
    const sslStatus = getSSLCertificateStatus(check);
    const regionLabel = getRegionLabel(check.checkRegion);
    const isOffline = check.status === 'offline';

    return (
        <GlowCard
            className={cn(
                "relative p-4 space-y-3 cursor-pointer transition-all duration-200 group flex flex-col justify-between h-full",
                check.disabled && "opacity-50",
                isOffline && "ring-1 ring-red-500/20",
                isOptimisticallyUpdating && !isFolderUpdating && "animate-pulse bg-primary/5",
                draggable && "cursor-grab active:cursor-grabbing",
                className
            )}
            onClick={() => onEdit(check)}
            draggable={draggable}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
        >
            {/* Drag Handle - visible on hover when enabled */}
            {showDragHandle && (
                <div 
                    className="absolute left-0 top-0 bottom-0 w-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing bg-gradient-to-r from-muted/50 to-transparent rounded-l-xl"
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <GripVertical className="size-4 text-muted-foreground" />
                </div>
            )}

            {/* Header Row */}
            <div className="flex items-start justify-between gap-3 min-h-[28px]">
                {/* Selection Checkbox Space */}
                <div className="flex items-center gap-3">
                    {!hideCheckbox ? (
                        <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => onSelect?.(check.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="mt-1"
                            title={isSelected ? 'Deselect' : 'Select'}
                        />
                    ) : (
                        /* Spacer to keep alignment identical between views */
                        <div className="w-[18px]" />
                    )}
                </div>

                {/* Status and SSL */}
                <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
                    <SSLTooltip sslCertificate={check.sslCertificate} url={check.url}>
                        <div className="cursor-help">
                            <sslStatus.icon
                                className={`w-4 h-4 ${sslStatus.color}`}
                            />
                        </div>
                    </SSLTooltip>
                    <StatusBadge
                        status={check.status}
                        tooltip={{
                            httpStatus: check.lastStatusCode,
                            latencyMsP50: check.responseTime,
                            lastCheckTs: check.lastChecked,
                            failureReason: check.lastError,
                            ssl: check.sslCertificate
                                ? {
                                    valid: check.sslCertificate.valid,
                                    daysUntilExpiry: check.sslCertificate.daysUntilExpiry,
                                }
                                : undefined,
                        }}
                    />

                    {/* Actions */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <IconButton
                                icon={<MoreVertical className="w-4 h-4" />}
                                size="sm"
                                variant="ghost"
                                aria-label="More actions"
                                className="text-muted-foreground hover:text-primary hover:bg-primary/10 pointer-events-auto p-1 transition-colors cursor-pointer"
                                onClick={(e) => e.stopPropagation()}
                            />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className={`${glassClasses} z-[55]`}>
                            <DropdownMenuItem
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (!check.disabled && !isManuallyChecking) {
                                        onCheckNow(check.id);
                                    }
                                }}
                                disabled={check.disabled || isManuallyChecking}
                                className="cursor-pointer font-mono"
                            >
                                {isManuallyChecking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                                <span className="ml-2">{isManuallyChecking ? 'Checking...' : 'Check now'}</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onToggleStatus(check.id, !check.disabled);
                                }}
                                className="cursor-pointer font-mono"
                            >
                                {check.disabled ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                                <span className="ml-2">{check.disabled ? 'Enable' : 'Disable'}</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={(e) => {
                                    e.stopPropagation();
                                    window.open(check.url, '_blank', 'noopener,noreferrer');
                                }}
                                className="cursor-pointer font-mono"
                            >
                                <ExternalLink className="w-3 h-3" />
                                <span className="ml-2">Open URL</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />

                            {onSetFolder && (
                                <DropdownMenuSub>
                                    <DropdownMenuSubTrigger
                                        className="cursor-pointer font-mono"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <Folder className="w-3 h-3" />
                                        <span className="ml-2">Move to folder</span>
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent className={`${glassClasses}`}>
                                        <DropdownMenuItem
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onSetFolder(check.id, null);
                                            }}
                                            className="cursor-pointer font-mono"
                                        >
                                            <span>Unsorted</span>
                                        </DropdownMenuItem>
                                        {folderOptions.map((f) => (
                                            <DropdownMenuItem
                                                key={f}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onSetFolder(check.id, f);
                                                }}
                                                className="cursor-pointer font-mono"
                                            >
                                                <span className="truncate max-w-[220px]">{f}</span>
                                            </DropdownMenuItem>
                                        ))}
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                openNewFolderDialog?.(check);
                                            }}
                                            className="cursor-pointer font-mono"
                                        >
                                            <Plus className="w-3 h-3" />
                                            <span className="ml-2">New folder…</span>
                                        </DropdownMenuItem>
                                    </DropdownMenuSubContent>
                                </DropdownMenuSub>
                            )}

                            <DropdownMenuItem
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onEdit(check);
                                }}
                                className="cursor-pointer font-mono"
                            >
                                <Edit className="w-3 h-3" />
                                <span className="ml-2">Edit</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDelete(check);
                                }}
                                className="cursor-pointer font-mono text-destructive focus:text-destructive"
                            >
                                <Trash2 className="w-3 h-3" />
                                <span className="ml-2">Delete</span>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            {/* Name and URL */}
            <div className="space-y-1">
                <div className="font-medium font-sans text-foreground flex items-center gap-2">
                    {highlightText(check.name, searchQuery)}
                </div>
                <div className="text-sm font-mono text-muted-foreground break-all">
                    {highlightText(check.url, searchQuery)}
                </div>
                {(((check.folder ?? '').trim()) || regionLabel) && (
                    <div className="pt-1 flex flex-wrap items-center gap-2">
                        {(check.folder ?? '').trim() && (
                            <Badge variant="secondary" className={cn(
                                "font-mono text-[11px]",
                                folderColor && folderColor !== 'default' && `bg-${folderColor}-500/20 text-${folderColor}-400 border-${folderColor}-400/30`
                            )}>
                                {(check.folder ?? '').trim()}
                            </Badge>
                        )}
                        {regionLabel && (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Badge variant="outline" className="font-mono text-[11px] cursor-default">
                                        {regionLabel.short}
                                    </Badge>
                                </TooltipTrigger>
                                <TooltipContent className={`${glassClasses}`}>
                                    <span className="text-xs font-mono">Region: {regionLabel.long}</span>
                                </TooltipContent>
                            </Tooltip>
                        )}
                    </div>
                )}
            </div>

            {/* Details Grid */}
            <div className="grid grid-cols-2 gap-3 text-sm">
                {/* Type */}
                <div className="flex items-center gap-2">
                    {getTypeIcon(check.type)}
                    <span className="font-mono text-muted-foreground">
                        {getTypeLabel(check.type)}
                    </span>
                </div>

                {/* Response Time */}
                <div className="font-mono text-muted-foreground text-right flex justify-end">
                    {formatResponseTime(check.responseTime)}
                </div>

                {/* Last Checked */}
                <div className="flex items-center gap-2 col-span-2">
                    <Clock className="w-3 h-3 text-muted-foreground" />
                    <span className="font-mono text-muted-foreground">
                        {formatLastChecked(check.lastChecked)}
                    </span>
                </div>

                {/* Check Interval */}
                <div className="flex items-center gap-2 col-span-2">
                    <Clock className="w-3 h-3 text-muted-foreground" />
                    <span className="font-mono text-muted-foreground">
                        {(() => {
                            const seconds = (check.checkFrequency ?? 10) * 60;
                            const interval = CHECK_INTERVALS.find(i => i.value === seconds);
                            return interval ? interval.label : `${check.checkFrequency ?? 10} minutes`;
                        })()}
                    </span>
                </div>
            </div>

            {/* Never Checked - Mobile inline banner */}
            {!check.lastChecked && !check.disabled && (
                <NeverCheckedOverlay onCheckNow={() => onCheckNow(check.id)} />
            )}
        </GlowCard>
    );
};

export default CheckCard;
