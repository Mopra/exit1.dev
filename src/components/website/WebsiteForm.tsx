import React, { useId, useState, useCallback } from 'react';
import { Button, Input } from '../ui';
import { theme, typography } from '../../config/theme';

interface WebsiteFormProps {
  name: string;
  url: string;
  onNameChange: (value: string) => void;
  onUrlChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  disabled?: boolean;
}

interface ValidationErrors {
  name?: string;
  url?: string;
}

const WebsiteForm: React.FC<WebsiteFormProps> = React.memo(({
  name,
  url,
  onNameChange,
  onUrlChange,
  onSubmit,
  disabled = false
}) => {
  const nameId = useId();
  const urlId = useId();
  const formId = useId();
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [touched, setTouched] = useState({ name: false, url: false });

  // Validation functions
  const validateName = useCallback((value: string): string | undefined => {
    if (!value.trim()) {
      return 'Website name is required';
    }
    if (value.trim().length < 2) {
      return 'Website name must be at least 2 characters';
    }
    if (value.trim().length > 50) {
      return 'Website name must be less than 50 characters';
    }
    return undefined;
  }, []);

  const validateUrl = useCallback((value: string): string | undefined => {
    if (!value.trim()) {
      return 'Website URL is required';
    }
    
    try {
      const urlObj = new URL(value);
      if (!urlObj.protocol.startsWith('http')) {
        return 'URL must start with http:// or https://';
      }
      if (!urlObj.hostname) {
        return 'URL must include a valid domain';
      }
      return undefined;
    } catch {
      return 'Please enter a valid URL (e.g., https://example.com)';
    }
  }, []);

  // Handle input changes with validation
  const handleNameChange = useCallback((value: string) => {
    onNameChange(value);
    if (touched.name) {
      const error = validateName(value);
      setErrors(prev => ({ ...prev, name: error }));
    }
  }, [onNameChange, touched.name, validateName]);

  const handleUrlChange = useCallback((value: string) => {
    // Auto-add https:// if no protocol is specified
    let processedUrl = value.trim();
    if (processedUrl && !processedUrl.match(/^https?:\/\//)) {
      processedUrl = `https://${processedUrl}`;
    }
    
    onUrlChange(processedUrl);
    
    // Auto-fill website name based on current URL
    if (processedUrl && processedUrl.includes('.')) {
      try {
        const urlObj = new URL(processedUrl);
        const hostname = urlObj.hostname;
        
        // Only auto-fill if we have a valid hostname with a domain
        if (hostname && hostname.includes('.') && hostname.length > 3) {
          // Convert hostname to friendly name
          let friendlyName = hostname
            .replace(/^www\./, '') // Remove www
            .split('.')
            .slice(0, -1) // Remove TLD
            .join('.')
            .replace(/[^a-zA-Z0-9]/g, ' ') // Replace non-alphanumeric with spaces
            .replace(/\s+/g, ' ') // Replace multiple spaces with single space
            .trim()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()) // Capitalize each word
            .join(' ');
          
          // If the result is empty or too short, use the full hostname
          if (!friendlyName || friendlyName.length < 2) {
            friendlyName = hostname.replace(/^www\./, '');
          }
          
          onNameChange(friendlyName);
        }
      } catch {
        // If URL parsing fails, don't auto-fill
      }
    }
    
    if (touched.url) {
      const error = validateUrl(processedUrl);
      setErrors(prev => ({ ...prev, url: error }));
    }
  }, [onUrlChange, touched.url, validateUrl, name, onNameChange]);

  // Handle blur events to show validation
  const handleNameBlur = useCallback(() => {
    setTouched(prev => ({ ...prev, name: true }));
    const error = validateName(name);
    setErrors(prev => ({ ...prev, name: error }));
  }, [name, validateName]);

  const handleUrlBlur = useCallback(() => {
    setTouched(prev => ({ ...prev, url: true }));
    const error = validateUrl(url);
    setErrors(prev => ({ ...prev, url: error }));
  }, [url, validateUrl]);

  // Enhanced submit handler with full validation
  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate all fields
    const nameError = validateName(name);
    const urlError = validateUrl(url);
    
    setErrors({ name: nameError, url: urlError });
    setTouched({ name: true, url: true });
    
    // Only submit if no errors
    if (!nameError && !urlError) {
      onSubmit(e);
    }
  }, [name, url, validateName, validateUrl, onSubmit]);

  const hasErrors = Boolean(errors.name || errors.url);
  const isFormValid = !hasErrors && name.trim() && url.trim();

  return (
    <form 
      id={formId}
      onSubmit={handleSubmit} 
      className="space-y-6 sm:space-y-4 mb-6 px-4 py-12 relative"
      aria-label="Add new website monitoring"
      noValidate
    >
      <div className="flex flex-col md:flex-row gap-6 sm:gap-4">

      <div className="flex-1">
          <Input
            id={urlId}
            label="Website URL"
            type="url"
            value={url}
            onChange={(e) => handleUrlChange(e.target.value)}
            onBlur={handleUrlBlur}
            placeholder="https://example.com"
            disabled={disabled}
            required
            pattern="https?://.*"
            autoComplete="url"
            inputMode="url"
            error={errors.url}
            touched={touched.url}
          />
        </div>

        <div className="flex-1">
          <Input
            id={nameId}
            label="Website Name"
            type="text"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            onBlur={handleNameBlur}
            placeholder="My Amazing Website"
            disabled={disabled}
            required
            minLength={2}
            maxLength={50}
            autoComplete="off"
            error={errors.name}
            touched={touched.name}
          />
        </div>
        

        
        <div className="flex items-start">
          <Button
            type="submit"
            disabled={disabled || !isFormValid}
            size="lg"
            className="mt-7"
            aria-describedby={disabled ? 'form-disabled-message' : undefined}
          >
            Add Website
          </Button>
        </div>
      </div>
      
      {disabled && (
        <div 
          id="form-disabled-message"
          className={`text-xs ${theme.colors.text.muted} ${typography.fontFamily.mono} mt-2`}
          role="status"
          aria-live="polite"
        >
          You have reached the maximum limit of 10 active websites. Disable some websites to add new ones.
        </div>
      )}
    </form>
  );
});

WebsiteForm.displayName = 'WebsiteForm';

export default WebsiteForm; 