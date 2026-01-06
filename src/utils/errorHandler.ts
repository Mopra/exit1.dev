export interface ParsedError {
  title: string;
  message: string;
  details?: string;
  suggestions?: string[];
}

export function parseFirebaseError(error: any): ParsedError {
  const errorMessage = error?.message || 'Unknown error occurred';
  
  // Firestore connection errors
  if (errorMessage.includes('400 (Bad Request)') || errorMessage.includes('firestore.googleapis.com')) {
    return {
      title: 'Connection Error',
      message: 'Unable to connect to the database. Please try again.',
      details: errorMessage,
      suggestions: [
        'Refresh the page and try again',
        'Check your internet connection',
        'Wait a moment and try again',
        'Contact support if the problem persists'
      ]
    };
  }

  // Firestore permission errors
  if (errorMessage.includes('permission-denied') || errorMessage.includes('Permission denied')) {
    return {
      title: 'Permission Denied',
      message: 'You don\'t have permission to perform this action.',
      details: errorMessage,
      suggestions: [
        'Sign out and sign back in',
        'Refresh the page',
        'Contact support if the problem persists'
      ]
    };
  }

  // Firestore unauthenticated errors
  if (errorMessage.includes('unauthenticated') || errorMessage.includes('Authentication required')) {
    return {
      title: 'Authentication Required',
      message: 'Please sign in to continue.',
      details: errorMessage,
      suggestions: [
        'Sign in to your account',
        'Refresh the page and try again'
      ]
    };
  }

  // Rate limiting errors
  if (errorMessage.includes('Rate limit exceeded')) {
    if (errorMessage.includes('per minute')) {
      return {
        title: 'Too Many Requests',
        message: 'You\'re adding checks too quickly. Please wait a moment before trying again.',
        details: errorMessage,
        suggestions: [
          'Wait 1 minute before adding another check',
          'Consider adding multiple checks at once if needed'
        ]
      };
    }
    if (errorMessage.includes('per hour')) {
      return {
        title: 'Hourly Limit Reached',
        message: 'You\'ve reached the maximum number of checks you can add per hour.',
        details: errorMessage,
        suggestions: [
          'Wait until the next hour to add more checks',
          'Consider enabling Nano for higher limits'
        ]
      };
    }
    if (errorMessage.includes('per day')) {
      return {
        title: 'Daily Limit Reached',
        message: 'You\'ve reached the maximum number of checks you can add per day.',
        details: errorMessage,
        suggestions: [
          'Wait until tomorrow to add more checks',
          'Consider enabling Nano for higher limits'
        ]
      };
    }
  }

  // Domain limit errors
  if (errorMessage.includes('Too many checks for the same domain')) {
    return {
      title: 'Domain Limit Reached',
      message: 'You\'ve reached the maximum number of checks allowed for this domain.',
      details: errorMessage,
      suggestions: [
        'Delete some existing checks for this domain',
        'Use different subdomains if needed',
        'Contact support if you need more checks for this domain'
      ]
    };
  }

  // Duplicate check errors
  if (errorMessage.includes('already exists')) {
    return {
      title: 'Check Already Exists',
      message: 'A check for this URL already exists.',
      details: errorMessage,
      suggestions: [
        'Use a different path, subdomain, or protocol if needed',
        'Update the existing check instead'
      ]
    };
  }

  // Blocked domain errors
  if (errorMessage.includes('not allowed for monitoring')) {
    return {
      title: 'Domain Not Allowed',
      message: 'This domain cannot be monitored for security reasons.',
      details: errorMessage,
      suggestions: [
        'Use a public website URL',
        'Avoid localhost, test domains, or private IPs',
        'Contact support if this is a legitimate website'
      ]
    };
  }

  // Suspicious pattern errors
  if (errorMessage.includes('Suspicious pattern detected')) {
    return {
      title: 'Suspicious Activity Detected',
      message: 'Your request was flagged as potentially suspicious.',
      details: errorMessage,
      suggestions: [
        'Ensure you\'re adding legitimate websites',
        'Avoid adding many similar URLs at once',
        'Contact support if this is a false positive'
      ]
    };
  }

  // Maximum checks limit
  if (errorMessage.includes('maximum limit')) {
    return {
      title: 'Maximum Checks Reached',
      message: 'You\'ve reached the maximum number of checks allowed.',
      details: errorMessage,
      suggestions: [
        'Delete some existing checks',
        'Enable Nano for more checks',
        'Contact support for higher limits'
      ]
    };
  }

  // URL validation errors
  if (errorMessage.includes('URL validation failed')) {
    return {
      title: 'Invalid URL',
      message: 'The URL format is not valid.',
      details: errorMessage,
      suggestions: [
        'Ensure the URL starts with http:// or https://',
        'Check for typos in the URL',
        'Make sure the URL is publicly accessible'
      ]
    };
  }

  // Default error
  return {
    title: 'Error Adding Check',
    message: 'Something went wrong while adding your check.',
    details: errorMessage,
    suggestions: [
      'Try again in a moment',
      'Check your internet connection',
      'Contact support if the problem persists'
    ]
  };
} 
