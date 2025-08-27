import { useState, useEffect } from 'react';

const WEBSITE_URL_STORAGE_KEY = 'exit1_website_url';

export const useWebsiteUrl = () => {
  console.log('useWebsiteUrl hook initialized');
  const [websiteUrl, setWebsiteUrl] = useState<string | null>(null);
  const [isValidUrl, setIsValidUrl] = useState(false);
  const [hasProcessed, setHasProcessed] = useState(false);

  useEffect(() => {
    console.log('useWebsiteUrl hook running, current URL:', window.location.href);
    
    // App.tsx already handles the URL parameter, so we only need to check localStorage
    const storedWebsiteUrl = localStorage.getItem(WEBSITE_URL_STORAGE_KEY);
    console.log('useWebsiteUrl: Checking localStorage for stored URL:', storedWebsiteUrl);
    
    if (storedWebsiteUrl) {
      console.log('Found stored website URL:', storedWebsiteUrl);
      setWebsiteUrl(storedWebsiteUrl);
      setIsValidUrl(true);
      setHasProcessed(true);
      localStorage.removeItem(WEBSITE_URL_STORAGE_KEY);
      console.log('useWebsiteUrl: Removed stored URL from localStorage');
    } else {
      setHasProcessed(true);
    }
  }, []); // Only run once on mount

  const clearWebsiteUrl = () => {
    console.log('Clearing website URL state');
    setWebsiteUrl(null);
    setIsValidUrl(false);
    setHasProcessed(true);
    
    // Also clear from localStorage to prevent any cache issues
    localStorage.removeItem(WEBSITE_URL_STORAGE_KEY);
    console.log('Cleared website URL from localStorage');
  };

  console.log('useWebsiteUrl hook returning:', { websiteUrl, isValidUrl, hasProcessed });
  return { websiteUrl, isValidUrl, hasProcessed, clearWebsiteUrl };
};
