import { useState } from 'react';
import { Button, Input, Label, Card, CheckIntervalSelector, Select } from '../ui';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faChevronUp, faGlobe, faCode, faCog, faServer, faShieldAlt, faClock, faCheckCircle } from '@fortawesome/free-solid-svg-icons';
import { theme, typography } from '../../config/theme';

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
          <h3 className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium text-lg`}>
            Check Type
          </h3>
        </div>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => handleTypeChange('website')}
            className={`p-4 rounded-xl border transition-all duration-200 relative cursor-pointer ${
              type === 'website'
                ? `${theme.colors.border.primary} ${theme.colors.background.card}`
                : `${theme.colors.border.secondary} ${theme.colors.background.hover}`
            }`}
          >
            {type === 'website' && (
              <div className="absolute -top-2 -right-2 w-6 h-6 bg-white rounded-full flex items-center justify-center shadow-lg">
                <div className="w-3 h-3 bg-black rounded-full"></div>
              </div>
            )}
            <div className="flex items-center gap-3">
              <FontAwesomeIcon 
                icon={faGlobe} 
                className={`w-5 h-5 ${type === 'website' ? 'text-white' : theme.colors.text.primary}`} 
              />
              <div className="text-left">
                <div className={`${typography.fontFamily.mono} ${type === 'website' ? 'text-white' : theme.colors.text.primary} font-medium text-base`}>
                  Website
                </div>
                <div className={`${typography.fontFamily.sans} ${type === 'website' ? 'text-white/80' : theme.colors.text.muted} text-sm`}>
                  Monitor website availability
                </div>
              </div>
            </div>
          </button>
          
          <button
            type="button"
            onClick={() => handleTypeChange('rest_endpoint')}
            className={`p-4 rounded-xl border transition-all duration-200 relative cursor-pointer ${
              type === 'rest_endpoint'
                ? `${theme.colors.border.primary} ${theme.colors.background.card}`
                : `${theme.colors.border.secondary} ${theme.colors.background.hover}`
            }`}
          >
            {type === 'rest_endpoint' && (
              <div className="absolute -top-2 -right-2 w-6 h-6 bg-white rounded-full flex items-center justify-center shadow-lg">
                <div className="w-3 h-3 bg-black rounded-full"></div>
              </div>
            )}
            <div className="flex items-center gap-3">
              <FontAwesomeIcon 
                icon={faCode} 
                className={`w-5 h-5 ${type === 'rest_endpoint' ? 'text-white' : theme.colors.text.primary}`} 
              />
              <div className="text-left">
                <div className={`${typography.fontFamily.mono} ${type === 'rest_endpoint' ? 'text-white' : theme.colors.text.primary} font-medium text-base`}>
                  REST Endpoint
                </div>
                <div className={`${typography.fontFamily.sans} ${type === 'rest_endpoint' ? 'text-white/80' : theme.colors.text.muted} text-sm`}>
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
          <h3 className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium text-lg`}>
            Basic Information
          </h3>
        </div>
        
        <div className="grid grid-cols-1 gap-6">
          <div className="space-y-2">
            <Label htmlFor="url" className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium`}>
              URL
            </Label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none z-10">
                <span className={`${theme.colors.text.muted} font-bold text-sm`}>https://</span>
              </div>
              <Input
                id="url"
                type="text"
                value={url}
                onChange={handleUrlChange}
                placeholder="example.com"
                className="pl-23"
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

      {/* Advanced Options */}
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className={`flex items-center gap-3 p-3 rounded-lg border transition-all duration-200 cursor-pointer ${
            showAdvanced 
              ? `${theme.colors.border.primary} ${theme.colors.background.card}` 
              : `${theme.colors.border.secondary} ${theme.colors.background.hover}`
          }`}
        >
          <FontAwesomeIcon icon={faCog} className={`w-4 h-4 ${showAdvanced ? 'text-white' : theme.colors.text.secondary}`} />
          <span className={`${typography.fontFamily.mono} font-medium ${showAdvanced ? 'text-white' : theme.colors.text.secondary}`}>
            Advanced Configuration
          </span>
          <FontAwesomeIcon 
            icon={showAdvanced ? faChevronUp : faChevronDown} 
            className={`w-3 h-3 ml-auto transition-transform duration-200 ${showAdvanced ? 'text-white' : theme.colors.text.secondary}`} 
          />
        </button>

        {showAdvanced && (
          <div className={`space-y-6 p-6 rounded-xl border ${theme.colors.background.card} ${theme.shadows.glass}`}>
            {/* HTTP Method Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <FontAwesomeIcon icon={faServer} className={`w-4 h-4 ${theme.colors.text.primary}`} />
                <h4 className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium text-base`}>
                  Request Configuration
                </h4>
              </div>
              
              <div className="grid grid-cols-1 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="httpMethod" className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium`}>
                    HTTP Method
                  </Label>
                  <Select
                    id="httpMethod"
                    value={httpMethod}
                    onChange={(e) => setHttpMethod(e.target.value as any)}
                    options={[
                      { value: 'HEAD', label: 'HEAD (Recommended for websites)' },
                      { value: 'GET', label: 'GET' },
                      { value: 'POST', label: 'POST' },
                      { value: 'PUT', label: 'PUT' },
                      { value: 'PATCH', label: 'PATCH' },
                      { value: 'DELETE', label: 'DELETE' }
                    ]}
                    helperText={type === 'website' 
                      ? 'HEAD is fastest for basic availability checks'
                      : 'Choose the appropriate HTTP method for your API'
                    }
                  />
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
            </div>

            {/* Headers Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <FontAwesomeIcon icon={faShieldAlt} className={`w-4 h-4 ${theme.colors.text.primary}`} />
                <h4 className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium text-base`}>
                  Request Headers
                </h4>
              </div>
              
              <div className="space-y-2">
                <textarea
                  id="requestHeaders"
                  value={requestHeaders}
                  onChange={(e) => setRequestHeaders(e.target.value)}
                  placeholder="Authorization: Bearer token&#10;Content-Type: application/json&#10;User-Agent: CustomBot/1.0"
                  className={`w-full px-4 py-3 ${theme.colors.input.background} ${theme.colors.input.border} ${theme.colors.input.text} rounded-xl focus:outline-none ${theme.colors.input.focus} ${theme.colors.input.hover} resize-none`}
                  rows={3}
                />
                <p className={`${typography.fontFamily.sans} ${theme.colors.text.helper} text-xs`}>
                  One header per line in format: Key: Value
                </p>
              </div>
            </div>

            {/* Request Body Section */}
            {['POST', 'PUT', 'PATCH'].includes(httpMethod) && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faCode} className={`w-4 h-4 ${theme.colors.text.primary}`} />
                  <h4 className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium text-base`}>
                    Request Body
                  </h4>
                </div>
                
                <div className="space-y-2">
                  <textarea
                    id="requestBody"
                    value={requestBody}
                    onChange={(e) => setRequestBody(e.target.value)}
                    placeholder='{"key": "value"}'
                    className={`w-full px-4 py-3 ${theme.colors.input.background} ${theme.colors.input.border} ${theme.colors.input.text} rounded-xl focus:outline-none ${theme.colors.input.focus} ${theme.colors.input.hover} resize-none`}
                    rows={4}
                  />
                  <p className={`${typography.fontFamily.sans} ${theme.colors.text.helper} text-xs`}>
                    Valid JSON payload to send with the request
                  </p>
                </div>
              </div>
            )}

            {/* Response Validation Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <FontAwesomeIcon icon={faCheckCircle} className={`w-4 h-4 ${theme.colors.text.primary}`} />
                <h4 className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium text-base`}>
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
                <p className={`${typography.fontFamily.sans} ${theme.colors.text.helper} text-xs`}>
                  Comma-separated list of text that must be present in the response
                </p>
              </div>
            </div>

            {/* Check Frequency Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <FontAwesomeIcon icon={faClock} className={`w-4 h-4 ${theme.colors.text.primary}`} />
                <h4 className={`${typography.fontFamily.mono} ${theme.colors.text.primary} font-medium text-base`}>
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
      <div className="flex justify-end pt-6 border-t border-white/5">
        <Button 
          type="submit" 
          disabled={loading}
          variant="gradient"
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