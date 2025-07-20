import { useState, useCallback } from 'react';

export interface ValidationErrors {
  name?: string;
  url?: string;
}

export function useWebsiteFormValidation({
  name,
  url,
  onNameChange,
  onUrlChange
}: {
  name: string;
  url: string;
  onNameChange: (value: string) => void;
  onUrlChange: (value: string) => void;
}) {
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [touched, setTouched] = useState({ name: false, url: false });

  const validateName = useCallback((value: string): string | undefined => {
    if (!value.trim()) return 'Website name is required';
    if (value.trim().length < 2) return 'Website name must be at least 2 characters';
    if (value.trim().length > 50) return 'Website name must be less than 50 characters';
    return undefined;
  }, []);

  const validateUrl = useCallback((value: string): string | undefined => {
    if (!value.trim()) return 'Website URL is required';
    try {
      const urlObj = new URL(value);
      if (!urlObj.protocol.startsWith('http')) return 'URL must start with http:// or https://';
      if (!urlObj.hostname) return 'URL must include a valid domain';
      return undefined;
    } catch {
      return 'Please enter a valid URL (e.g., https://example.com)';
    }
  }, []);

  const handleNameChange = useCallback((value: string) => {
    onNameChange(value);
    if (touched.name) {
      const error = validateName(value);
      setErrors(prev => ({ ...prev, name: error }));
    }
  }, [onNameChange, touched.name, validateName]);

  const handleUrlChange = useCallback((value: string) => {
    let processedUrl = value.trim();
    if (processedUrl && !processedUrl.match(/^https?:\/\//)) {
      processedUrl = `https://${processedUrl}`;
    }
    onUrlChange(processedUrl);
    if (processedUrl && processedUrl.includes('.')) {
      try {
        const urlObj = new URL(processedUrl);
        const hostname = urlObj.hostname;
        if (hostname && hostname.includes('.') && hostname.length > 3) {
          let friendlyName = hostname
            .replace(/^www\./, '')
            .split('.')
            .slice(0, -1)
            .join('.')
            .replace(/[^a-zA-Z0-9]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
          if (!friendlyName || friendlyName.length < 2) {
            friendlyName = hostname.replace(/^www\./, '');
          }
          onNameChange(friendlyName);
        }
      } catch {}
    }
    if (touched.url) {
      const error = validateUrl(processedUrl);
      setErrors(prev => ({ ...prev, url: error }));
    }
  }, [onUrlChange, touched.url, validateUrl, onNameChange]);

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

  const validateForm = useCallback(() => {
    const nameError = validateName(name);
    const urlError = validateUrl(url);
    setErrors({ name: nameError, url: urlError });
    setTouched({ name: true, url: true });
    return !nameError && !urlError;
  }, [name, url, validateName, validateUrl]);

  const hasErrors = Boolean(errors.name || errors.url);
  const isFormValid = !hasErrors && name.trim() && url.trim();

  return {
    errors,
    touched,
    handleNameChange,
    handleUrlChange,
    handleNameBlur,
    handleUrlBlur,
    validateForm,
    isFormValid
  };
} 