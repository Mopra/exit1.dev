import { useState } from 'react';
import { Button, Input, Label, Card, CheckIntervalSelector, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui';
import { 
  ChevronDown, 
  ChevronUp, 
  Globe, 
  Code, 
  Settings, 
  Server, 
  Shield, 
  Clock, 
  CheckCircle 
} from 'lucide-react';

interface CheckFormProps {
  onSubmit: (data: {
    name: string;
    url: string;
    type: 'website' | 'rest_endpoint';
    checkFrequency?: number;
    httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
    expectedStatusCodes?: number[];
    requestHeaders?: { [key: string]: string };
    requestBody?: string;
    responseValidation?: {
      containsText?: string[];
      jsonPath?: string;
      expectedValue?: unknown;
    };
  }) => void;
  loading?: boolean;
  noCard?: boolean;
}

export default function CheckForm({ onSubmit, loading = false, noCard = false }: CheckFormProps) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [type, setType] = useState<'website' | 'rest_endpoint'>('website');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [httpMethod, setHttpMethod] = useState<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'>('HEAD');
  const [expectedStatusCodes, setExpectedStatusCodes] = useState<string>('200,201,202,204,301,302,303,307,308,404,403,429');
  const [requestHeaders, setRequestHeaders] = useState<string>('');
  const [requestBody, setRequestBody] = useState<string>('');
  const [containsText, setContainsText] = useState<string>('');
  const [checkFrequency, setCheckFrequency] = useState<number>(10);

  // Auto-generate name from URL when URL changes
  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newUrl = e.target.value;
    setUrl(newUrl);
    
    if (!newUrl.trim()) {
      setName('');
      return;
    }
    
    try {
      if (newUrl.length > 0) {
        const fullUrl = `https://${newUrl}`;
        const url = new URL(fullUrl);
        const hostname = url.hostname;
        
        if (hostname && hostname.length > 0) {
          let friendlyName = hostname
            .replace(/^www\./, '')
            .split('.')
            .slice(0, -1)
            .join('.')
            .replace(/[-_.]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
          
          if (!friendlyName || friendlyName.length < 2) {
            const domainWithoutExtension = hostname
              .replace(/^www\./, '')
              .split('.')
              .slice(0, -1)
              .join('.');
            friendlyName = domainWithoutExtension || hostname.replace(/^www\./, '');
          }
          
          setName(friendlyName);
        }
      } else {
        setName('');
      }
    } catch {
      setName('');
    }
  };

  // Reset HTTP method and status codes when type changes
  const handleTypeChange = (newType: 'website' | 'rest_endpoint') => {
    setType(newType);
    if (newType === 'website') {
      setHttpMethod('HEAD');
      setExpectedStatusCodes('200,201,202,204,301,302,303,307,308,404,403,429');
    } else {
      setHttpMethod('GET');
      setExpectedStatusCodes('200,201,202');
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const fullUrl = `https://${url}`;
    
    const statusCodes = expectedStatusCodes
      .split(',')
      .map(s => parseInt(s.trim()))
      .filter(n => !isNaN(n));
    
    const headers: { [key: string]: string } = {};
    if (requestHeaders.trim()) {
      requestHeaders.split('\n').forEach(line => {
        const [key, value] = line.split(':').map(s => s.trim());
        if (key && value) {
          headers[key] = value;
        }
      });
    }
    
    const validation: any = {};
    if (containsText.trim()) {
      validation.containsText = containsText.split(',').map(s => s.trim()).filter(s => s);
    }
    
    onSubmit({
      name,
      url: fullUrl,
      type,
      checkFrequency,
      httpMethod: showAdvanced ? httpMethod : undefined,
      expectedStatusCodes: showAdvanced ? statusCodes : undefined,
      requestHeaders: showAdvanced ? headers : undefined,
      requestBody: showAdvanced ? requestBody : undefined,
      responseValidation: showAdvanced ? validation : undefined
    });
    
    if (!loading) {
      setName('');
      setUrl('');
      setType('website');
      setShowAdvanced(false);
      setHttpMethod('HEAD');
      setExpectedStatusCodes('200,201,202,204,301,302,404');
      setRequestHeaders('');
      setRequestBody('');
      setContainsText('');
      setCheckFrequency(10);
    }
  };

  const formContent = (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* Check Type Selection */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-lg">
            Check Type
          </h3>
        </div>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => handleTypeChange('website')}
            className={`p-4 rounded-lg border transition-all duration-200 relative cursor-pointer ${
              type === 'website'
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input bg-card text-card-foreground hover:bg-accent hover:text-accent-foreground'
            }`}
          >
            {type === 'website' && (
              <div className="absolute -top-2 -right-2 w-6 h-6 bg-primary-foreground rounded-full flex items-center justify-center shadow-lg">
                <div className="w-3 h-3 bg-primary rounded-full"></div>
              </div>
            )}
            <div className="flex items-center gap-3">
              <Globe className="w-5 h-5" />
              <div className="text-left">
                <div className="font-medium text-base">
                  Website
                </div>
                <div className="text-sm text-muted-foreground">
                  Monitor website availability
                </div>
              </div>
            </div>
          </button>
          
          <button
            type="button"
            onClick={() => handleTypeChange('rest_endpoint')}
            className={`p-4 rounded-lg border transition-all duration-200 relative cursor-pointer ${
              type === 'rest_endpoint'
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input bg-card text-card-foreground hover:bg-accent hover:text-accent-foreground'
            }`}
          >
            {type === 'rest_endpoint' && (
              <div className="absolute -top-2 -right-2 w-6 h-6 bg-primary-foreground rounded-full flex items-center justify-center shadow-lg">
                <div className="w-3 h-3 bg-primary rounded-full"></div>
              </div>
            )}
            <div className="flex items-center gap-3">
              <Code className="w-5 h-5" />
              <div className="text-left">
                <div className="font-medium text-base">
                  REST Endpoint
                </div>
                <div className="text-sm text-muted-foreground">
                  Monitor API endpoints
                </div>
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* Basic Information */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-lg">
            Basic Information
          </h3>
        </div>
        
        <div className="grid grid-cols-1 gap-6">
          <div className="space-y-2">
            <Label htmlFor="url" className="font-medium">
              URL
            </Label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none z-10">
                <span className="text-muted-foreground font-bold text-sm">https://</span>
              </div>
              <Input
                id="url"
                type="text"
                value={url}
                onChange={handleUrlChange}
                placeholder="example.com"
                className="pl-20"
                required
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Enter the domain or full URL to monitor
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="name" className="font-medium">
              Display Name
            </Label>
            <Input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Website"
              required
            />
            <p className="text-xs text-muted-foreground">
              A friendly name to identify this check
            </p>
          </div>
        </div>
      </div>

      {/* Advanced Options */}
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className={`flex items-center gap-3 p-3 rounded-lg border transition-all duration-200 cursor-pointer w-full ${
            showAdvanced 
              ? 'border-primary bg-primary text-primary-foreground' 
              : 'border-input bg-card text-card-foreground hover:bg-accent hover:text-accent-foreground'
          }`}
        >
          <Settings className="w-4 h-4" />
          <span className="font-medium">
            Advanced Configuration
          </span>
          {showAdvanced ? (
            <ChevronUp className="w-3 h-3 ml-auto" />
          ) : (
            <ChevronDown className="w-3 h-3 ml-auto" />
          )}
        </button>

        {showAdvanced && (
          <div className="space-y-6 p-6 rounded-lg border bg-card">
            {/* HTTP Method Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4" />
                <h4 className="font-medium text-base">
                  Request Configuration
                </h4>
              </div>
              
              <div className="grid grid-cols-1 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="httpMethod" className="font-medium">
                    HTTP Method
                  </Label>
                  <Select value={httpMethod} onValueChange={(value) => setHttpMethod(value as any)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select HTTP method" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="HEAD">HEAD (Recommended for websites)</SelectItem>
                      <SelectItem value="GET">GET</SelectItem>
                      <SelectItem value="POST">POST</SelectItem>
                      <SelectItem value="PUT">PUT</SelectItem>
                      <SelectItem value="PATCH">PATCH</SelectItem>
                      <SelectItem value="DELETE">DELETE</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {type === 'website' 
                      ? 'HEAD is fastest for basic availability checks'
                      : 'Choose the appropriate HTTP method for your API'
                    }
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="expectedStatusCodes" className="font-medium">
                    Expected Status Codes
                  </Label>
                  <Input
                    id="expectedStatusCodes"
                    type="text"
                    value={expectedStatusCodes}
                    onChange={(e) => setExpectedStatusCodes(e.target.value)}
                    placeholder="200,201,202"
                  />
                  <p className="text-xs text-muted-foreground">
                    Comma-separated list of acceptable HTTP status codes
                  </p>
                </div>
              </div>
            </div>

            {/* Headers Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4" />
                <h4 className="font-medium text-base">
                  Request Headers
                </h4>
              </div>
              
              <div className="space-y-2">
                <textarea
                  id="requestHeaders"
                  value={requestHeaders}
                  onChange={(e) => setRequestHeaders(e.target.value)}
                  placeholder="Authorization: Bearer token&#10;Content-Type: application/json&#10;User-Agent: CustomBot/1.0"
                  className="w-full px-4 py-3 rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-none"
                  rows={3}
                />
                <p className="text-xs text-muted-foreground">
                  One header per line in format: Key: Value
                </p>
              </div>
            </div>

            {/* Request Body Section */}
            {['POST', 'PUT', 'PATCH'].includes(httpMethod) && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Code className="w-4 h-4" />
                  <h4 className="font-medium text-base">
                    Request Body
                  </h4>
                </div>
                
                <div className="space-y-2">
                  <textarea
                    id="requestBody"
                    value={requestBody}
                    onChange={(e) => setRequestBody(e.target.value)}
                    placeholder='{"key": "value"}'
                    className="w-full px-4 py-3 rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-none"
                    rows={4}
                  />
                  <p className="text-xs text-muted-foreground">
                    Valid JSON payload to send with the request
                  </p>
                </div>
              </div>
            )}

            {/* Response Validation Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4" />
                <h4 className="font-medium text-base">
                  Response Validation
                </h4>
              </div>
              
              <div className="space-y-2">
                <Input
                  id="containsText"
                  type="text"
                  value={containsText}
                  onChange={(e) => setContainsText(e.target.value)}
                  placeholder="success,online,healthy"
                />
                <p className="text-xs text-muted-foreground">
                  Comma-separated list of text that must be present in the response
                </p>
              </div>
            </div>

            {/* Check Frequency Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4" />
                <h4 className="font-medium text-base">
                  Monitoring Schedule
                </h4>
              </div>
              
              <CheckIntervalSelector
                value={checkFrequency}
                onChange={(value) => setCheckFrequency(value)}
                helperText="How often should we check this endpoint?"
              />
            </div>
          </div>
        )}
      </div>

      {/* Submit Button */}
      <div className="flex justify-end pt-6 border-t">
        <Button 
          type="submit" 
          disabled={loading}
          variant="default"
          className="min-w-[120px] w-full sm:w-auto"
        >
          {loading ? 'Adding...' : 'Add Check'}
        </Button>
      </div>
    </form>
  );

  return noCard ? formContent : (
    <Card className="p-6">
      {formContent}
    </Card>
  );
} 