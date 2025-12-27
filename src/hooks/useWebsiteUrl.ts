import { useState, useEffect } from 'react';

const WEBSITE_URL_STORAGE_KEY = 'exit1_website_url';

export const useWebsiteUrl = () => {
  const [websiteUrl, setWebsiteUrl] = useState<string | null>(null);
  const [isValidUrl, setIsValidUrl] = useState(false);
  const [hasProcessed, setHasProcessed] = useState(false);

  useEffect(() => {
    // App.tsx already handles the URL parameter, so we only need to check localStorage
    const storedWebsiteUrl = localStorage.getItem(WEBSITE_URL_STORAGE_KEY);

    if (storedWebsiteUrl) {
      setWebsiteUrl(storedWebsiteUrl);
      setIsValidUrl(true);
      setHasProcessed(true);
      localStorage.removeItem(WEBSITE_URL_STORAGE_KEY);
    } else {
      setHasProcessed(true);
    }
  }, []); // Only run once on mount

  const clearWebsiteUrl = () => {
    setWebsiteUrl(null);
    setIsValidUrl(false);
    setHasProcessed(true);

    // Also clear from localStorage to prevent any cache issues
    localStorage.removeItem(WEBSITE_URL_STORAGE_KEY);
  };

  return { websiteUrl, isValidUrl, hasProcessed, clearWebsiteUrl };
};
