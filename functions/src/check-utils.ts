import * as logger from "firebase-functions/logger";
import { Website } from "./types";
import { CONFIG } from "./config";
import { insertCheckHistory } from './bigquery';
import { checkSecurityAndExpiry } from './security-utils';

// Store every check in BigQuery - no restrictions
export const storeCheckHistory = async (website: Website, checkResult: {
  status: 'online' | 'offline';
  responseTime: number;
  statusCode: number;
  error?: string;
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
}) => {
  try {
    const now = Date.now();
    
    // Store EVERY check in BigQuery only
    await insertCheckHistory({
      id: `${website.id}_${now}_${Math.random().toString(36).substr(2, 9)}`,
      website_id: website.id,
      user_id: website.userId,
      timestamp: now,
      status: checkResult.status,
      response_time: checkResult.responseTime,
      status_code: checkResult.statusCode,
      error: checkResult.error,
    });
    
    // No longer storing in Firestore subcollections - BigQuery handles all history
  } catch (error) {
    logger.warn(`Error storing check history for website ${website.id}:`, error);
    // Don't throw - history storage failure shouldn't break the main check
  }
};

// Function to categorize status codes
export function categorizeStatusCode(statusCode: number): 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN' {
  if ([200, 201, 202, 204].includes(statusCode)) {
    return 'UP';
  } else if ([301, 302, 303, 307, 308].includes(statusCode)) {
    return 'REDIRECT';
  } else if ([400, 403, 404, 429].includes(statusCode)) {
    return 'REACHABLE_WITH_ERROR';
  } else {
    return 'DOWN';
  }
}

// Unified function to check both websites and REST endpoints with advanced validation
export async function checkRestEndpoint(website: Website): Promise<{
  status: 'online' | 'offline';
  responseTime: number;
  statusCode: number;
  error?: string;
  responseBody?: string;
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
  domainExpiry?: {
    valid: boolean;
    registrar?: string;
    domainName?: string;
    expiryDate?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
}> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutMs = CONFIG.getAdaptiveTimeout(website);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {

    
    // Check SSL certificate and domain expiry first
    const securityChecks = await checkSecurityAndExpiry(website.url);
    const sslCertificate = securityChecks.sslCertificate;
    const domainExpiry = securityChecks.domainExpiry;
    
    // Determine default values based on website type
    // Default to 'website' type if not specified (for backward compatibility)
    const websiteType = website.type || 'website';
    const defaultMethod = websiteType === 'website' ? 'HEAD' : 'GET';
    const defaultStatusCodes = websiteType === 'website' ? [200, 201, 202, 204, 301, 302, 303, 307, 308, 404, 403, 429] : [200, 201, 202];
    
    // Prepare request options
    const requestOptions: RequestInit = {
      method: website.httpMethod || defaultMethod,
      signal: controller.signal,
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Accept': '*/*',
        'Cache-Control': 'no-cache',
        ...website.requestHeaders
      }
    };
    
    // Add request body for POST/PUT/PATCH requests
    if (['POST', 'PUT', 'PATCH'].includes(website.httpMethod || 'GET') && website.requestBody) {
      requestOptions.body = website.requestBody;
      requestOptions.headers = {
        ...requestOptions.headers,
        'Content-Type': 'application/json'
      };
    }
    
    const response = await fetch(website.url, requestOptions);
    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;
    

    
    

    
    // Get response body for validation (only for small responses to avoid memory issues)
    let responseBody: string | undefined;
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) < 10000) { // Only read if < 10KB
      responseBody = await response.text();
    }
    
    // Check if status code is in expected range (for logging purposes)
    const expectedCodes = website.expectedStatusCodes || defaultStatusCodes;
    const statusCodeValid = expectedCodes.includes(response.status);
    
    // Validate response body if specified (for logging purposes)
    let bodyValidationPassed = true;
    if (responseBody && website.responseValidation) {
      const validation = website.responseValidation;
      
      // Check for required text in response
      if (validation.containsText && validation.containsText.length > 0) {
        bodyValidationPassed = validation.containsText.every(text => 
          responseBody!.toLowerCase().includes(text.toLowerCase())
        );
      }
      
      // JSONPath validation (if implemented)
      if (validation.jsonPath && validation.expectedValue !== undefined) {
        try {
          JSON.parse(responseBody); // Validate JSON format
          // TODO: Implement JSONPath validation
          // For now, we'll skip this validation
        } catch {
          bodyValidationPassed = false;
        }
      }
    }
    
    // Log validation results for debugging
    if (!statusCodeValid || !bodyValidationPassed) {
      logger.info(`Validation failed for ${website.url}: statusCodeValid=${statusCodeValid}, bodyValidationPassed=${bodyValidationPassed}`);
    }
    
    // Determine status based on status code categorization
    const detailedStatus = categorizeStatusCode(response.status);
    
    // For backward compatibility, map to online/offline
    // UP and REDIRECT are considered online, REACHABLE_WITH_ERROR and DOWN are considered offline
    const isOnline = detailedStatus === 'UP' || detailedStatus === 'REDIRECT';
    
    return {
      status: isOnline ? 'online' : 'offline',
      responseTime,
      statusCode: response.status,
      responseBody,
      sslCertificate,
      domainExpiry,
      detailedStatus
    };
    
  } catch (error) {
    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    

    
    // Still return security check results even if HTTP check fails
    const securityChecks = await checkSecurityAndExpiry(website.url);
    
    return {
      status: 'offline',
      responseTime,
      statusCode: 0,
      error: errorMessage,
      sslCertificate: securityChecks.sslCertificate,
      domainExpiry: securityChecks.domainExpiry,
      detailedStatus: 'DOWN'
    };
  }
}

