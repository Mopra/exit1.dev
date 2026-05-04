import { useState, useCallback, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
  Textarea,
  Label,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui';
import { Upload, FileText, AlertCircle, CheckCircle2, XCircle, Download, Globe, Code, ArrowRight, Server, Radio, Wifi, Activity } from 'lucide-react';
import { apiClient } from '../../api/client';
import type { AddWebsiteRequest } from '../../api/types';

type CheckType = 'website' | 'rest_endpoint' | 'tcp' | 'udp' | 'ping' | 'websocket' | 'redirect';

const CHECK_TYPE_OPTIONS: { value: CheckType; label: string; icon: React.ElementType }[] = [
  { value: 'website', label: 'Website', icon: Globe },
  { value: 'rest_endpoint', label: 'API Endpoint', icon: Code },
  { value: 'redirect', label: 'Redirect', icon: ArrowRight },
  { value: 'tcp', label: 'TCP Port', icon: Server },
  { value: 'udp', label: 'UDP Port', icon: Radio },
  { value: 'ping', label: 'Ping', icon: Activity },
  { value: 'websocket', label: 'WebSocket', icon: Wifi },
];

const URL_PLACEHOLDERS: Record<CheckType, string> = {
  website: `https://example.com\nhttps://api.example.com/health\nexample.org, My Website`,
  rest_endpoint: `https://api.example.com/health\nhttps://api.example.com/status, Status API`,
  redirect: `https://old.example.com\nhttps://legacy.example.com, Legacy Site\nexample.org/old-page`,
  tcp: `db.example.com:5432\nredis.example.com:6379, Redis`,
  udp: `dns.example.com:53\nntp.example.com:123, NTP`,
  ping: `server.example.com\n8.8.8.8, Google DNS`,
  websocket: `wss://ws.example.com/feed\nwss://realtime.example.com/socket, Realtime`,
};

const CSV_PLACEHOLDERS: Record<CheckType, string> = {
  website: `name,url,expected_status_codes,check_frequency\nMy Site,https://example.com,200,5\nBlog,https://blog.example.com,200;301,15`,
  rest_endpoint: `name,url,http_method,expected_status_codes,response_json_path,response_expected_value\nHealth,https://api.example.com/health,GET,200,$.status,"ok"`,
  redirect: `name,url,redirect_expected_target,redirect_match_mode,expected_status_codes\nRadio Christmas,https://streaming.radiochristmas.co.uk/RadioChristmas,radioxmaslive.radioca.st/stream,contains,302\nThe90s,https://streaming.radiochristmas.co.uk/The90sBiggestAnthems,7k1xgurghg0uv,contains,302`,
  tcp: `name,url,check_frequency\nDatabase,db.example.com:5432,5`,
  udp: `name,url,check_frequency\nDNS,dns.example.com:53,15`,
  ping: `name,url,check_frequency\nServer,server.example.com,5`,
  websocket: `name,url,check_frequency\nFeed,wss://ws.example.com/feed,10`,
};

const COLUMN_HINTS: Record<CheckType, { required: string; relevant: string; tip?: string }> = {
  website: {
    required: 'url',
    relevant: 'name, expected_status_codes, check_frequency, response_contains_text, cache_control_no_cache',
  },
  rest_endpoint: {
    required: 'url',
    relevant: 'name, http_method, expected_status_codes, request_headers (JSON), request_body, response_json_path, response_expected_value',
  },
  redirect: {
    required: 'url, redirect_expected_target',
    relevant: 'name, redirect_match_mode (contains | exact), expected_status_codes',
    tip: 'Use match_mode "contains" with a unique slug to verify it survives the entire redirect chain (works through token-signed hops).',
  },
  tcp: { required: 'url (host:port)', relevant: 'name, check_frequency' },
  udp: { required: 'url (host:port)', relevant: 'name, check_frequency' },
  ping: { required: 'url (host)', relevant: 'name, check_frequency' },
  websocket: { required: 'url (ws:// or wss://)', relevant: 'name, check_frequency' },
};

interface BulkImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

interface ImportResult {
  url: string;
  name?: string;
  success: boolean;
  error?: string;
}

interface ParsedCheck extends AddWebsiteRequest {
  name: string;
}

// Parse plain text URLs (one per line)
function parsePlainText(content: string): ParsedCheck[] {
  const lines = content.trim().split('\n');
  const results: ParsedCheck[] = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    // Check if it's a URL or URL with name (tab/comma separated)
    const parts = trimmed.split(/[\t,]/);
    let url = parts[0].trim();
    const name = parts[1]?.trim() || '';
    
    // Auto-add https:// if missing
    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    // Validate URL
    try {
      new URL(url);
      results.push({ url, name: name || extractNameFromUrl(url) });
    } catch {
      // Skip invalid URLs
    }
  }
  
  return results;
}

// Parse a single CSV field (handles quoted values)
function parseCSVField(field: string): string {
  const trimmed = field.trim();
  // Remove surrounding quotes and unescape double quotes
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed;
}

// Parse a CSV line into fields (handles quoted fields with commas)
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  
  return fields.map(parseCSVField);
}

// Parse CSV content with all settings
function parseCSV(content: string, defaultType?: CheckType): ParsedCheck[] {
  const lines = content.trim().split('\n');
  const results: ParsedCheck[] = [];
  
  if (lines.length === 0) return results;
  
  // Parse header to determine column mapping
  const headerLine = lines[0].toLowerCase();
  const hasHeader = headerLine.includes('url') || headerLine.includes('name');
  
  let columnMap: Map<string, number>;
  
  if (hasHeader) {
    const headers = parseCSVLine(lines[0].toLowerCase());
    columnMap = new Map();
    headers.forEach((header, index) => {
      // Normalize header names
      const normalized = header.replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      columnMap.set(normalized, index);
    });
    // Map common alternative header names
    if (!columnMap.has('url') && columnMap.has('source_url')) {
      columnMap.set('url', columnMap.get('source_url')!);
    }
    if (!columnMap.has('expected_status_codes') && columnMap.has('status')) {
      columnMap.set('expected_status_codes', columnMap.get('status')!);
    }
    if (!columnMap.has('expected_status_codes') && columnMap.has('status_code')) {
      columnMap.set('expected_status_codes', columnMap.get('status_code')!);
    }
  } else {
    // Default: name, url
    columnMap = new Map([['name', 0], ['url', 1]]);
  }
  
  const startIndex = hasHeader ? 1 : 0;
  
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const fields = parseCSVLine(line);
    
    // Get URL (required)
    const urlIndex = columnMap.get('url');
    if (urlIndex === undefined || !fields[urlIndex]) continue;
    
    let url = fields[urlIndex];
    
    // Auto-add https:// if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    // Validate URL
    try {
      new URL(url);
    } catch {
      continue;
    }
    
    // Build the check request
    const check: ParsedCheck = {
      url,
      name: '',
    };
    if (defaultType) {
      check.type = defaultType;
    }
    
    // Name
    const nameIndex = columnMap.get('name');
    if (nameIndex !== undefined && fields[nameIndex]) {
      check.name = fields[nameIndex];
    } else {
      check.name = extractNameFromUrl(url);
    }
    
    // Type
    const typeIndex = columnMap.get('type');
    if (typeIndex !== undefined && fields[typeIndex]) {
      const typeValue = fields[typeIndex].toLowerCase();
      if (['website', 'rest_endpoint', 'tcp', 'udp', 'ping', 'websocket', 'redirect'].includes(typeValue)) {
        check.type = typeValue as 'website' | 'rest_endpoint' | 'tcp' | 'udp' | 'ping' | 'websocket' | 'redirect';
      }
    }
    
    // HTTP Method
    const methodIndex = columnMap.get('http_method');
    if (methodIndex !== undefined && fields[methodIndex]) {
      const methodValue = fields[methodIndex].toUpperCase();
      if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(methodValue)) {
        check.httpMethod = methodValue as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
      }
    }
    
    // Expected Status Codes (comma-separated or single value)
    const statusIndex = columnMap.get('expected_status_codes');
    if (statusIndex !== undefined && fields[statusIndex]) {
      const codes = fields[statusIndex].split(/[,;]/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n >= 100 && n < 600);
      if (codes.length > 0) {
        check.expectedStatusCodes = codes;
      }
    }
    
    // Check Frequency (minutes)
    const freqIndex = columnMap.get('check_frequency');
    if (freqIndex !== undefined && fields[freqIndex]) {
      const freq = parseInt(fields[freqIndex], 10);
      if (!isNaN(freq) && freq > 0) {
        check.checkFrequency = freq;
      }
    }
    
    // Response Time Limit (ms) - still supported if manually added
    const rtlIndex = columnMap.get('response_time_limit');
    if (rtlIndex !== undefined && fields[rtlIndex]) {
      const limit = parseInt(fields[rtlIndex], 10);
      if (!isNaN(limit) && limit > 0) {
        check.responseTimeLimit = limit;
      }
    }
    
    // Down Confirmation Attempts
    const dcaIndex = columnMap.get('down_confirmation_attempts');
    if (dcaIndex !== undefined && fields[dcaIndex]) {
      const attempts = parseInt(fields[dcaIndex], 10);
      if (!isNaN(attempts) && attempts >= 0) {
        check.downConfirmationAttempts = attempts;
      }
    }
    
    // Cache Control No Cache
    const ccncIndex = columnMap.get('cache_control_no_cache');
    if (ccncIndex !== undefined && fields[ccncIndex]) {
      const value = fields[ccncIndex].toLowerCase();
      check.cacheControlNoCache = value === 'true' || value === 'yes' || value === '1';
    }
    
    // Request Headers (JSON format)
    const headersIndex = columnMap.get('request_headers');
    if (headersIndex !== undefined && fields[headersIndex]) {
      try {
        const headers = JSON.parse(fields[headersIndex]);
        if (typeof headers === 'object' && headers !== null) {
          check.requestHeaders = headers;
        }
      } catch {
        // Invalid JSON, skip
      }
    }
    
    // Request Body
    const bodyIndex = columnMap.get('request_body');
    if (bodyIndex !== undefined && fields[bodyIndex]) {
      check.requestBody = fields[bodyIndex];
    }
    
    // Response Validation - Contains Text
    const containsTextIndex = columnMap.get('response_contains_text');
    if (containsTextIndex !== undefined && fields[containsTextIndex]) {
      const texts = fields[containsTextIndex].split('|').map(s => s.trim()).filter(Boolean);
      if (texts.length > 0) {
        check.responseValidation = { ...check.responseValidation, containsText: texts };
      }
    }
    
    // Response Validation - JSON Path
    const jsonPathIndex = columnMap.get('response_json_path');
    if (jsonPathIndex !== undefined && fields[jsonPathIndex]) {
      check.responseValidation = { ...check.responseValidation, jsonPath: fields[jsonPathIndex] };
    }
    
    // Response Validation - Expected Value
    const expectedValueIndex = columnMap.get('response_expected_value');
    if (expectedValueIndex !== undefined && fields[expectedValueIndex]) {
      try {
        check.responseValidation = { ...check.responseValidation, expectedValue: JSON.parse(fields[expectedValueIndex]) };
      } catch {
        // Not valid JSON, use as string
        check.responseValidation = { ...check.responseValidation, expectedValue: fields[expectedValueIndex] };
      }
    }

    // Redirect Validation - Expected Target
    const redirectTargetIndex = columnMap.get('redirect_expected_target') ?? columnMap.get('target_url') ?? columnMap.get('target');
    if (redirectTargetIndex !== undefined && fields[redirectTargetIndex]) {
      let target = fields[redirectTargetIndex];
      if (target && !target.startsWith('http://') && !target.startsWith('https://')) {
        target = 'https://' + target;
      }
      check.redirectValidation = {
        expectedTarget: target,
        matchMode: 'contains',
      };
      // If type wasn't explicitly set, infer redirect type
      if (!check.type) {
        check.type = 'redirect';
      }
    }

    // Redirect Validation - Match Mode
    const redirectMatchModeIndex = columnMap.get('redirect_match_mode') ?? columnMap.get('match_mode');
    if (redirectMatchModeIndex !== undefined && fields[redirectMatchModeIndex]) {
      const mode = fields[redirectMatchModeIndex].toLowerCase();
      if (mode === 'exact' || mode === 'contains') {
        check.redirectValidation = {
          expectedTarget: check.redirectValidation?.expectedTarget || '',
          matchMode: mode,
        };
      }
    }

    results.push(check);
  }
  
  return results;
}

function extractNameFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const TEMPLATE_BY_TYPE: Record<CheckType, string> = {
  website:
    'name,url,expected_status_codes,check_frequency,response_contains_text\n' +
    'My Site,https://example.com,200,5,\n' +
    'Blog,https://blog.example.com,200;301,15,Welcome\n',
  rest_endpoint:
    'name,url,http_method,expected_status_codes,check_frequency,request_headers,request_body,response_json_path,response_expected_value\n' +
    'Health,https://api.example.com/health,GET,200,5,,,$.status,"ok"\n' +
    'Create User,https://api.example.com/users,POST,201;200,15,"{""Authorization"":""Bearer TOKEN""}","{""name"":""test""}",,\n',
  redirect:
    'name,url,redirect_expected_target,redirect_match_mode,expected_status_codes,check_frequency\n' +
    'Radio Christmas,https://streaming.radiochristmas.co.uk/RadioChristmas,radioxmaslive.radioca.st/stream,contains,302,5\n' +
    'The 90s,https://streaming.radiochristmas.co.uk/The90sBiggestAnthems,7k1xgurghg0uv,contains,302,5\n' +
    'Old Domain,https://old.example.com,https://new.example.com,exact,301;302,30\n',
  tcp:
    'name,url,check_frequency\n' +
    'Database,db.example.com:5432,5\n' +
    'Redis,redis.example.com:6379,5\n',
  udp:
    'name,url,check_frequency\n' +
    'DNS,dns.example.com:53,15\n',
  ping:
    'name,url,check_frequency\n' +
    'Server,server.example.com,5\n' +
    'Google DNS,8.8.8.8,5\n',
  websocket:
    'name,url,check_frequency\n' +
    'Realtime Feed,wss://ws.example.com/feed,10\n',
};

function downloadCSVTemplate(type: CheckType) {
  const blob = new Blob([TEMPLATE_BY_TYPE[type]], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bulk-import-${type}-template.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function BulkImportModal({ open, onOpenChange, onSuccess }: BulkImportModalProps) {
  const [importType, setImportType] = useState<'urls' | 'csv'>('urls');
  const [content, setContent] = useState('');
  const [checkType, setCheckType] = useState<CheckType>('website');
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClose = useCallback(() => {
    if (!isImporting) {
      setContent('');
      setCheckType('website');
      setResults([]);
      setShowResults(false);
      setProgress(0);
      onOpenChange(false);
    }
  }, [isImporting, onOpenChange]);

  const parseContent = useCallback((): ParsedCheck[] => {
    if (importType === 'csv') {
      return parseCSV(content, checkType);
    }
    return parsePlainText(content).map(item => ({ ...item, type: checkType }));
  }, [content, importType, checkType]);

  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      setContent(text);
    };
    reader.readAsText(file);
    
    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const handleImport = useCallback(async () => {
    const items = parseContent();
    if (items.length === 0) return;

    setIsImporting(true);
    setShowResults(true);
    setProgress(0);
    setResults([]);

    try {
      const result = await apiClient.bulkAddChecks(items);

      if (result.success && result.data?.results) {
        const importResults: ImportResult[] = result.data.results.map((r) => ({
          url: r.url,
          name: r.name,
          success: r.success,
          error: r.error,
        }));
        setResults(importResults);

        if (importResults.some(r => r.success)) {
          onSuccess();
        }
      } else {
        // Entire request failed - mark all as failed
        const importResults: ImportResult[] = items.map((item) => ({
          url: item.url,
          name: item.name,
          success: false,
          error: result.error || 'Bulk import failed',
        }));
        setResults(importResults);
      }
    } catch (error) {
      const importResults: ImportResult[] = items.map((item) => ({
        url: item.url,
        name: item.name,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      setResults(importResults);
    }

    setProgress(100);
    setIsImporting(false);
  }, [parseContent, onSuccess]);

  const parsedItems = content ? parseContent() : [];
  const successCount = results.filter(r => r.success).length;
  const failureCount = results.filter(r => !r.success).length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5" />
            Bulk Import Checks
          </DialogTitle>
          <DialogDescription>
            Import multiple checks at once by entering URLs or uploading a CSV file.
          </DialogDescription>
        </DialogHeader>

        {!showResults ? (
          <>
            <div className="space-y-2">
              <Label>Check Type</Label>
              <Select value={checkType} onValueChange={(v) => setCheckType(v as CheckType)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHECK_TYPE_OPTIONS.map(({ value, label, icon: Icon }) => (
                    <SelectItem key={value} value={value}>
                      <span className="flex items-center gap-2">
                        <Icon className="w-4 h-4" />
                        {label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Applies to all imported rows. CSV rows can override per-row by including a <code className="font-mono">type</code> column.
              </p>
            </div>

            <Tabs value={importType} onValueChange={(v) => setImportType(v as typeof importType)} className="flex-1 min-h-0 flex flex-col">
              <TabsList className="w-fit">
                <TabsTrigger value="urls" className="cursor-pointer min-w-[5.5rem] px-3 touch-manipulation">
                  <FileText className="size-4 flex-shrink-0" />
                  <span>URLs</span>
                </TabsTrigger>
                <TabsTrigger value="csv" className="cursor-pointer min-w-[5.5rem] px-3 touch-manipulation">
                  <Upload className="size-4 flex-shrink-0" />
                  <span>CSV Upload</span>
                </TabsTrigger>
              </TabsList>

              <TabsContent value="urls" className="flex-1 mt-4 space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="urls-input">URLs (one per line)</Label>
                  <Textarea
                    id="urls-input"
                    placeholder={URL_PLACEHOLDERS[checkType]}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    className="min-h-[200px] font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    Enter one URL per line. Optionally add a name after a comma or tab.
                    URLs without http(s):// will have https:// added automatically.
                    {checkType === 'redirect' && ' To set redirect targets per URL, switch to CSV Upload.'}
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="csv" className="flex-1 mt-4 space-y-3">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="csv-input">CSV Content</Label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => downloadCSVTemplate(checkType)}
                      className="gap-1 h-7 text-xs"
                    >
                      <Download className="w-3 h-3" />
                      Download {CHECK_TYPE_OPTIONS.find(o => o.value === checkType)?.label} Template
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,text/csv"
                      onChange={handleFileUpload}
                      className="hidden"
                      id="csv-file-input"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      className="gap-2"
                    >
                      <Upload className="w-4 h-4" />
                      Choose File
                    </Button>
                  </div>
                  <Textarea
                    id="csv-input"
                    placeholder={CSV_PLACEHOLDERS[checkType]}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    className="min-h-[160px] font-mono text-sm"
                  />
                  <div className="rounded-md bg-muted p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground space-y-0.5">
                    <p><strong className="text-foreground">Required:</strong> {COLUMN_HINTS[checkType].required}</p>
                    <p><strong className="text-foreground">Optional:</strong> {COLUMN_HINTS[checkType].relevant}</p>
                  </div>
                  {COLUMN_HINTS[checkType].tip && (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Tip:</span> {COLUMN_HINTS[checkType].tip}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    First row is used as headers. Download the template to see every supported column.
                  </p>
                </div>
              </TabsContent>
            </Tabs>

            {parsedItems.length > 0 && (
              <div className="rounded-md bg-muted/50 p-3 text-sm">
                <p className="font-medium">{parsedItems.length} check{parsedItems.length !== 1 ? 's' : ''} detected</p>
                <ul className="mt-2 space-y-1 max-h-[100px] overflow-y-auto">
                  {parsedItems.slice(0, 5).map((item, i) => (
                    <li key={i} className="text-muted-foreground text-xs truncate">
                      {item.name} - {item.url}
                      {item.type && ` (${CHECK_TYPE_OPTIONS.find(o => o.value === item.type)?.label || item.type})`}
                      {item.httpMethod && item.httpMethod !== 'GET' && ` [${item.httpMethod}]`}
                      {item.redirectValidation?.expectedTarget && ` → ${item.redirectValidation.expectedTarget}`}
                    </li>
                  ))}
                  {parsedItems.length > 5 && (
                    <li className="text-muted-foreground text-xs">
                      ...and {parsedItems.length - 5} more
                    </li>
                  )}
                </ul>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={handleClose} disabled={isImporting}>
                Cancel
              </Button>
              <Button
                onClick={handleImport}
                disabled={parsedItems.length === 0 || isImporting}
                className="gap-2"
              >
                <Upload className="w-4 h-4" />
                Import {parsedItems.length > 0 ? `${parsedItems.length} Check${parsedItems.length !== 1 ? 's' : ''}` : 'Checks'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="flex-1 min-h-0 space-y-4">
              {isImporting && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Importing checks...</span>
                    <span>{Math.round(progress)}%</span>
                  </div>
                  <Progress value={progress} />
                </div>
              )}

              {!isImporting && (
                <div className="flex items-center gap-4 p-4 rounded-md bg-muted/50">
                  {failureCount === 0 ? (
                    <CheckCircle2 className="w-8 h-8 text-success" />
                  ) : successCount === 0 ? (
                    <XCircle className="w-8 h-8 text-destructive" />
                  ) : (
                    <AlertCircle className="w-8 h-8 text-warning" />
                  )}
                  <div>
                    <p className="font-medium">
                      {failureCount === 0
                        ? 'All checks imported successfully!'
                        : successCount === 0
                        ? 'Import failed'
                        : 'Import completed with some errors'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {successCount} succeeded, {failureCount} failed
                    </p>
                  </div>
                </div>
              )}

              <div className="max-h-[300px] overflow-y-auto space-y-2">
                {results.map((result, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-2 p-2 rounded-md text-sm ${
                      result.success ? 'bg-success/10' : 'bg-destructive/10'
                    }`}
                  >
                    {result.success ? (
                      <CheckCircle2 className="w-4 h-4 text-success mt-0.5 flex-shrink-0" />
                    ) : (
                      <XCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{result.name || result.url}</p>
                      {result.error && (
                        <p className="text-xs text-destructive truncate">{result.error}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <DialogFooter>
              {!isImporting && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowResults(false);
                      setResults([]);
                      setProgress(0);
                    }}
                  >
                    Import More
                  </Button>
                  <Button onClick={handleClose}>Done</Button>
                </>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default BulkImportModal;
