import { useState } from 'react';
import { Button, Input, Label, Card } from '../ui';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faChevronUp, faGlobe, faCode, faCog } from '@fortawesome/pro-regular-svg-icons';
import { theme, typography } from '../../config/theme';

interface CheckFormProps {
  onSubmit: (data: {
    name: string;
    url: string;
    type: 'website' | 'rest_endpoint';
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
  const [expectedStatusCodes, setExpectedStatusCodes] = useState<string>('200,201,202,204,301,302,404');
  const [requestHeaders, setRequestHeaders] = useState<string>('');
  const [requestBody, setRequestBody] = useState<string>('');
  const [containsText, setContainsText] = useState<string>('');

  // Auto-generate name from URL when URL changes
  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newUrl = e.target.value;
    setUrl(newUrl);
    
    // Clear name if URL is empty
    if (!newUrl.trim()) {
      setName('');
      return;
    }
    
    // Auto-generate name from URL
    try {
      // Process URL as you type (no dot requirement)
      if (newUrl.length > 0) {
        // Construct full URL with https:// prefix
        const fullUrl = `https://${newUrl}`;
        const url = new URL(fullUrl);
        const hostname = url.hostname;
        
        // Only auto-fill if we have a valid hostname
        if (hostname && hostname.length > 0) {
          // Convert hostname to friendly name
          let friendlyName = hostname
            .replace(/^www\./, '') // Remove www
            .split('.') // Split by dots to separate domain from extension
            .slice(0, -1) // Remove the last part (domain extension like .com, .org, etc.)
            .join('.') // Rejoin the remaining parts
            .replace(/[-_.]/g, ' ') // Replace hyphens, underscores, and dots with spaces
            .replace(/\s+/g, ' ') // Replace multiple spaces with single space
            .trim()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()) // Capitalize each word
            .join(' ');
          
          // If the result is empty or too short, use the domain without extension
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
        // Clear name if URL is empty
        setName('');
      }
    } catch {
      // If URL parsing fails, clear the name
      setName('');
    }
  };

  // Reset HTTP method and status codes when type changes
  const handleTypeChange = (newType: 'website' | 'rest_endpoint') => {
    setType(newType);
    if (newType === 'website') {
      setHttpMethod('HEAD'); // Default for websites
      setExpectedStatusCodes('200,201,202,204,301,302,404'); // More permissive for websites
    } else {
      setHttpMethod('GET'); // Default for REST endpoints
      setExpectedStatusCodes('200,201,202'); // Standard API status codes
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Construct full URL with https:// prefix
    const fullUrl = `https://${url}`;
    
    // Parse expected status codes
    const statusCodes = expectedStatusCodes
      .split(',')
      .map(s => parseInt(s.trim()))
      .filter(n => !isNaN(n));
    
    // Parse request headers
    const headers: { [key: string]: string } = {};
    if (requestHeaders.trim()) {
      requestHeaders.split('\n').forEach(line => {
        const [key, value] = line.split(':').map(s => s.trim());
        if (key && value) {
          headers[key] = value;
        }
      });
    }
    
    // Parse response validation
    const validation: any = {};
    if (containsText.trim()) {
      validation.containsText = containsText.split(',').map(s => s.trim()).filter(s => s);
    }
    
    onSubmit({
      name,
      url: fullUrl,
      type,
      httpMethod: showAdvanced ? httpMethod : undefined,
      expectedStatusCodes: showAdvanced ? statusCodes : undefined,
      requestHeaders: showAdvanced ? headers : undefined,
      requestBody: showAdvanced ? requestBody : undefined,
      responseValidation: showAdvanced ? validation : undefined
    });
    
    // Reset form after successful submission
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
    }
  };

  const formContent = (
    <form onSubmit={handleSubmit} className="space-y-6 sm:space-y-8">
      {/* Check Type Selection */}
      <div className="space-y-3 sm:space-y-4">
        <div className="flex items-center gap-2 mb-3 sm:mb-4">
          <h3 className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium text-base sm:text-lg`}>
            Check Type
          </h3>
        </div>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <button
            type="button"
            onClick={() => handleTypeChange('website')}
            className={`p-3 sm:p-4 rounded-lg border-2 transition-all duration-200 relative cursor-pointer ${
              type === 'website'
                ? `${theme.colors.border.primary} bg-white/10 backdrop-blur-sm shadow-lg`
                : `${theme.colors.border.secondary} hover:${theme.colors.border.primary} hover:bg-white/5`
            }`}
          >
            {type === 'website' && (
              <div className="absolute -top-2 -right-2 w-5 h-5 sm:w-6 sm:h-6 bg-white rounded-full flex items-center justify-center shadow-lg">
                <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 bg-black rounded-full"></div>
              </div>
            )}
            <div className="flex items-center gap-2 sm:gap-3">
              <FontAwesomeIcon icon={faGlobe} className={`w-4 h-4 sm:w-5 sm:h-5 ${type === 'website' ? 'text-white' : theme.colors.text.primary}`} />
              <div className="text-left">
                <div className={`${typography.fontFamily.mono} ${type === 'website' ? 'text-white' : theme.colors.text.primary} font-medium text-sm sm:text-base`}>
                  Website
                </div>
                <div className={`${typography.fontFamily.sans} ${type === 'website' ? 'text-white/80' : theme.colors.text.muted} text-xs sm:text-sm`}>
                  Monitor website availability
                </div>
              </div>
            </div>
          </button>
          
          <button
            type="button"
            onClick={() => handleTypeChange('rest_endpoint')}
            className={`p-3 sm:p-4 rounded-lg border-2 transition-all duration-200 relative cursor-pointer ${
              type === 'rest_endpoint'
                ? `${theme.colors.border.primary} bg-white/10 backdrop-blur-sm shadow-lg`
                : `${theme.colors.border.secondary} hover:${theme.colors.border.primary} hover:bg-white/5`
            }`}
          >
            {type === 'rest_endpoint' && (
              <div className="absolute -top-2 -right-2 w-5 h-5 sm:w-6 sm:h-6 bg-white rounded-full flex items-center justify-center shadow-lg">
                <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 bg-black rounded-full"></div>
              </div>
            )}
            <div className="flex items-center gap-2 sm:gap-3">
              <FontAwesomeIcon icon={faCode} className={`w-4 h-4 sm:w-5 sm:h-5 ${type === 'rest_endpoint' ? 'text-white' : theme.colors.text.primary}`} />
              <div className="text-left">
                <div className={`${typography.fontFamily.mono} ${type === 'rest_endpoint' ? 'text-white' : theme.colors.text.primary} font-medium text-sm sm:text-base`}>
                  REST Endpoint
                </div>
                <div className={`${typography.fontFamily.sans} ${type === 'rest_endpoint' ? 'text-white/80' : theme.colors.text.muted} text-xs sm:text-sm`}>
                  Monitor API endpoints
                </div>
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* Basic Information */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <h3 className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium text-base sm:text-lg`}>
            Basic Information
          </h3>
        </div>
        
        <div className="grid grid-cols-1 gap-4 sm:gap-6">
          <div className="space-y-2">
            <Label htmlFor="url" className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium`}>
              URL
            </Label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none z-10">
                <span className={`${theme.colors.text.muted} font-bold text-sm`}>https://</span>
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
            <p className={`${typography.fontFamily.sans} ${theme.colors.text.helper} text-xs`}>
              Enter the domain or full URL to monitor
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="name" className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium`}>
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
            <p className={`${typography.fontFamily.sans} ${theme.colors.text.helper} text-xs`}>
              A friendly name to identify this check
            </p>
          </div>
        </div>
      </div>

      {/* Advanced Options - Now available for both types */}
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className={`flex items-center gap-2 ${theme.colors.text.secondary} hover:${theme.colors.text.primary} transition-colors ${typography.fontFamily.mono} text-sm cursor-pointer`}
        >
          <FontAwesomeIcon icon={faCog} className="w-4 h-4" />
          <FontAwesomeIcon icon={showAdvanced ? faChevronUp : faChevronDown} className="w-3 h-3" />
          Advanced Configuration
        </button>

        {showAdvanced && (
          <div className="space-y-4 sm:space-y-6 p-3 sm:p-4 rounded-lg border border-white/5 bg-black/20">
            <div className="grid grid-cols-1 gap-4 sm:gap-6">
              <div className="space-y-2">
                <Label htmlFor="httpMethod" className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium`}>
                  HTTP Method
                </Label>
                <select
                  id="httpMethod"
                  value={httpMethod}
                  onChange={(e) => setHttpMethod(e.target.value as any)}
                  className={`w-full px-3 py-2 ${theme.colors.input.background} ${theme.colors.input.border} ${theme.colors.input.text} rounded-md focus:outline-none ${theme.colors.input.focus}`}
                >
                  <option value="HEAD">HEAD (Recommended for websites)</option>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="PATCH">PATCH</option>
                  <option value="DELETE">DELETE</option>
                </select>
                <p className={`${typography.fontFamily.sans} ${theme.colors.text.helper} text-xs`}>
                  {type === 'website' 
                    ? 'HEAD is fastest for basic availability checks'
                    : 'Choose the appropriate HTTP method for your API'
                  }
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="expectedStatusCodes" className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium`}>
                  Expected Status Codes
                </Label>
                <Input
                  id="expectedStatusCodes"
                  type="text"
                  value={expectedStatusCodes}
                  onChange={(e) => setExpectedStatusCodes(e.target.value)}
                  placeholder="200,201,202"
                />
                <p className={`${typography.fontFamily.sans} ${theme.colors.text.helper} text-xs`}>
                  Comma-separated list of acceptable HTTP status codes
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="requestHeaders" className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium`}>
                Request Headers
              </Label>
              <textarea
                id="requestHeaders"
                value={requestHeaders}
                onChange={(e) => setRequestHeaders(e.target.value)}
                placeholder="Authorization: Bearer token&#10;Content-Type: application/json&#10;User-Agent: CustomBot/1.0"
                className={`w-full px-3 py-2 ${theme.colors.input.background} ${theme.colors.input.border} ${theme.colors.input.text} rounded-md focus:outline-none ${theme.colors.input.focus} resize-none`}
                rows={3}
              />
              <p className={`${typography.fontFamily.sans} ${theme.colors.text.helper} text-xs`}>
                One header per line in format: Key: Value
              </p>
            </div>

            {['POST', 'PUT', 'PATCH'].includes(httpMethod) && (
              <div className="space-y-2">
                <Label htmlFor="requestBody" className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium`}>
                  Request Body (JSON)
                </Label>
                <textarea
                  id="requestBody"
                  value={requestBody}
                  onChange={(e) => setRequestBody(e.target.value)}
                  placeholder='{"key": "value"}'
                  className={`w-full px-3 py-2 ${theme.colors.input.background} ${theme.colors.input.border} ${theme.colors.input.text} rounded-md focus:outline-none ${theme.colors.input.focus} resize-none`}
                  rows={4}
                />
                <p className={`${typography.fontFamily.sans} ${theme.colors.text.helper} text-xs`}>
                  Valid JSON payload to send with the request
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="containsText" className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium`}>
                Response Validation
              </Label>
              <Input
                id="containsText"
                type="text"
                value={containsText}
                onChange={(e) => setContainsText(e.target.value)}
                placeholder="success,online,healthy"
              />
              <p className={`${typography.fontFamily.sans} ${theme.colors.text.helper} text-xs`}>
                Comma-separated list of text that must be present in the response
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Submit Button */}
      <div className="flex justify-end pt-4 sm:pt-6 border-t border-white/5">
        <Button 
          type="submit" 
          disabled={loading}
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