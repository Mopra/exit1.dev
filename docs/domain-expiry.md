# Domain Expiry Implementation

## Overview

The domain expiry feature provides comprehensive domain validation using **RDAP (Registration Data Access Protocol)** - the modern, free, JSON replacement for WHOIS. This gives you real expiry dates without expensive APIs.

## Current Implementation

### ✅ What Works (Free)
- **RDAP Integration**: Real domain expiry dates and registrar information
- **DNS Resolution**: Checks if domain resolves to IPv4/IPv6 addresses
- **Domain Structure**: Validates domain format using Public Suffix List (PSL)
- **IDN Support**: Handles internationalized domain names (punycode)
- **Intelligent Caching**: Caches RDAP data with smart refresh intervals
- **Local Domains**: Handles localhost and IP addresses
- **Error Handling**: Comprehensive error reporting
- **Rate Limiting**: Prevents RDAP server spam with intelligent backoff
- **Persistent Caching**: Firestore-based caching survives function restarts

### ✅ Real Data Available
- **Expiry Dates**: Actual domain expiration dates from RDAP (with enhanced pattern matching)
- **Registrar Info**: Real registrar names, IDs, and URLs
- **Nameservers**: DNS nameserver information
- **DNSSEC Status**: DNSSEC signing status
- **Domain Events**: All RDAP events (registration, expiration, transfers, etc.)
- **Domain Status**: Active, suspended, or other status indicators
- **Domain Validation**: Proper registrable domain extraction
- **Caching**: Reduces API calls with intelligent cache management

## Technical Details

### RDAP Validation Process
1. **Domain Extraction**: Extract registrable domain using PSL (e.g., `app.foo.co.uk` → `foo.co.uk`)
2. **IDN Conversion**: Convert internationalized domains to ASCII (punycode)
3. **RDAP Query**: Fetch domain data from multiple RDAP servers with fallback
4. **Enhanced Expiry Detection**: Parse events with multiple patterns (expiration, expiry, expires, renewal, registration)
5. **Comprehensive Data Extraction**: Nameservers, DNSSEC status, registrar details, domain events
6. **DNS Validation**: Optional DNS resolution check for reachability

### Rate Limiting & Anti-Spam Protection
- **24-Hour Minimum**: At least 24 hours between RDAP attempts for the same domain
- **Exponential Backoff**: Failed attempts use 2x, 4x, 8x backoff (max 7 days)
- **Max Attempts**: Maximum 3 failed attempts before extended backoff
- **Persistent Tracking**: Attempt counts and timestamps stored in Firestore
- **Smart Caching**: Uses cached data when available, only refreshes when needed

### Domain Structure Rules
- **PSL Validation**: Uses Public Suffix List for accurate TLD detection
- **IDN Support**: Handles internationalized domain names
- **IP Detection**: Automatically detects and handles IP addresses
- **Trailing Dots**: Strips trailing dots from hostnames

### Caching Strategy
- **Persistent Storage**: Firestore-based caching survives function restarts
- **Weekly**: Domains with >30 days until expiry
- **Daily**: Domains with ≤30 days until expiry
- **10-second timeout**: Prevents hanging requests
- **Multiple Servers**: Fallback between rdap.org, rdap.iana.org, and rdap.verisign.com

### Response Format
```typescript
{
  valid: boolean;
  domainName?: string;
  registrar?: string;
  registrarId?: string;
  registrarUrl?: string;
  expiryDate?: number; // timestamp
  daysUntilExpiry?: number;
  nameservers?: string[];
  hasDNSSEC?: boolean;
  status?: string[];
  events?: Array<{ action: string; date: string; actor?: string }>;
  error?: string;
}
```

## UI Components

### DomainExpiryTooltip
- Shows domain status with appropriate icons
- Displays comprehensive RDAP information (registrar, nameservers, DNSSEC)
- Shows detailed status messages for different RDAP scenarios
- Uses blue info icon for limited data status

### StatusBadge
- Shows domain status in status badges
- Displays registrar name and DNSSEC status
- Enhanced tooltip with comprehensive domain information

## Error Handling & Fallbacks

### RDAP Failure Scenarios
1. **Rate Limited (403/429)**: Server rejects requests due to rate limiting
2. **Not Found (404)**: Domain not found in RDAP database
3. **Bad Request (400)**: Invalid domain format or server issues
4. **Timeout**: Request takes too long (>10 seconds)
5. **Network Error**: Connection issues

### Fallback Strategy
1. **Try Multiple Servers**: rdap.org → rdap.iana.org → rdap.verisign.com
2. **Use Cached Data**: Return last known good data if available
3. **DNS Validation**: Fall back to DNS resolution check
4. **Graceful Degradation**: Provide meaningful error messages

### Error Messages
- `"RDAP data available (registrar: Example Registrar)"` - Success with registrar info
- `"RDAP data available (limited information)"` - Success with basic data
- `"RDAP data unavailable (using DNS validation only)"` - RDAP failed, DNS works
- `"RDAP data unavailable - Rate limited by server"` - Specific error details

## Testing

Use the enhanced test script:
```bash
node test-rdap-fix.js
```

Test URLs:
- `https://google.com` - Should show comprehensive RDAP data
- `https://github.com` - Should show registrar and nameserver info
- `https://nonexistent-domain-12345.com` - Should fail DNS validation
- `https://localhost:3000` - Should be marked as local domain
- `https://app.foo.co.uk` - Should extract registrable domain `foo.co.uk`

## Cost Analysis

| Method | Cost | Reliability | Data Quality |
|--------|------|-------------|--------------|
| RDAP | Free | High | Excellent |
| DNS Validation | Free | High | Basic |
| Public WHOIS | Free | Medium | Good |
| Paid WHOIS APIs | $50-500/month | High | Excellent |

## Migration Path

1. ✅ **Current**: RDAP + DNS validation with rate limiting
2. ✅ **Persistent Caching**: Firestore-based caching
3. ✅ **Anti-Spam**: Rate limiting and exponential backoff
4. 🔄 **Future**: Enhanced error recovery and monitoring

This approach provides **excellent data quality** while keeping costs at zero and preventing server spam.
