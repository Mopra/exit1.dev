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
} from '../ui';
import { Upload, FileText, AlertCircle, CheckCircle2, XCircle, Download } from 'lucide-react';
import { apiClient } from '../../api/client';
import type { AddWebsiteRequest } from '../../api/types';

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

// CSV column names mapping to AddWebsiteRequest fields
const CSV_COLUMNS = [
  'name',
  'url', 
  'type',
  'http_method',
  'expected_status_codes',
  'check_frequency',
  'down_confirmation_attempts',
  'cache_control_no_cache',
  'request_headers',
  'request_body',
  'response_contains_text',
  'response_json_path',
  'response_expected_value',
] as const;

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
function parseCSV(content: string): ParsedCheck[] {
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
      if (['website', 'rest_endpoint', 'tcp', 'udp'].includes(typeValue)) {
        check.type = typeValue as 'website' | 'rest_endpoint' | 'tcp' | 'udp';
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

function downloadCSVTemplate() {
  const headers = CSV_COLUMNS.join(',');
  const examples = [
    // Simple website check (1 hour interval)
    'My Website,https://example.com,website,GET,200,60,2,false,,,,',
    // REST API endpoint with POST (5 min interval)
    'API Create User,https://api.example.com/users,rest_endpoint,POST,201;200,5,1,true,"{""Authorization"": ""Bearer token123""}","{""name"": ""test""}",success,$.status,',
    // Health check with response validation (15 min interval)
    'Health Check,https://api.example.com/health,rest_endpoint,GET,200,15,0,false,,,healthy|ok,$.status,"ok"',
    // Simple blog check (1 hour interval)
    'Company Blog,https://blog.example.com,website,GET,200,60,3,false,,,,',
  ];
  
  const template = [headers, ...examples].join('\n');
  
  const blob = new Blob([template], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bulk-import-template.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function BulkImportModal({ open, onOpenChange, onSuccess }: BulkImportModalProps) {
  const [importType, setImportType] = useState<'urls' | 'csv'>('urls');
  const [content, setContent] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClose = useCallback(() => {
    if (!isImporting) {
      setContent('');
      setResults([]);
      setShowResults(false);
      setProgress(0);
      onOpenChange(false);
    }
  }, [isImporting, onOpenChange]);

  const parseContent = useCallback((): ParsedCheck[] => {
    if (importType === 'csv') {
      return parseCSV(content);
    }
    return parsePlainText(content);
  }, [content, importType]);

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

    const importResults: ImportResult[] = [];
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      
      try {
        const request: AddWebsiteRequest = { ...item };
        
        const result = await apiClient.addWebsite(request);
        
        if (result.success) {
          importResults.push({ url: item.url, name: item.name, success: true });
        } else {
          importResults.push({ url: item.url, name: item.name, success: false, error: result.error });
        }
      } catch (error) {
        importResults.push({
          url: item.url,
          name: item.name,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      
      setProgress(((i + 1) / items.length) * 100);
      setResults([...importResults]);
    }

    setIsImporting(false);
    
    // If any succeeded, trigger refresh
    if (importResults.some(r => r.success)) {
      onSuccess();
    }
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
            <Tabs value={importType} onValueChange={(v) => setImportType(v as typeof importType)} className="flex-1 min-h-0 flex flex-col">
              <TabsList className="w-full">
                <TabsTrigger value="urls" className="flex-1 cursor-pointer">
                  <FileText className="w-4 h-4 mr-2" />
                  URLs
                </TabsTrigger>
                <TabsTrigger value="csv" className="flex-1 cursor-pointer">
                  <Upload className="w-4 h-4 mr-2" />
                  CSV Upload
                </TabsTrigger>
              </TabsList>

              <TabsContent value="urls" className="flex-1 mt-4 space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="urls-input">URLs (one per line)</Label>
                  <Textarea
                    id="urls-input"
                    placeholder={`https://example.com\nhttps://api.example.com/health\nexample.org, My Website`}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    className="min-h-[200px] font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    Enter one URL per line. Optionally add a name after a comma or tab.
                    URLs without http(s):// will have https:// added automatically.
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
                      onClick={downloadCSVTemplate}
                      className="gap-1 h-7 text-xs"
                    >
                      <Download className="w-3 h-3" />
                      Download Template
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
                    placeholder={`name,url,type,http_method,expected_status_codes\nMy Website,https://example.com,website,GET,200\nAPI Check,https://api.example.com/health,rest_endpoint,GET,200`}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    className="min-h-[160px] font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    Upload a CSV file or paste content. Download the template for all available columns including type, HTTP method, expected status codes, response time limit, headers, and more.
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
                      {item.type && item.type !== 'website' && ` (${item.type})`}
                      {item.httpMethod && item.httpMethod !== 'GET' && ` [${item.httpMethod}]`}
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
                    <CheckCircle2 className="w-8 h-8 text-green-500" />
                  ) : successCount === 0 ? (
                    <XCircle className="w-8 h-8 text-destructive" />
                  ) : (
                    <AlertCircle className="w-8 h-8 text-yellow-500" />
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
                      result.success ? 'bg-green-500/10' : 'bg-destructive/10'
                    }`}
                  >
                    {result.success ? (
                      <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
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
