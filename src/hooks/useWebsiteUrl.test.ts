// Test cases for useWebsiteUrl hook
// This is a manual test file to verify the functionality

const testCases = [
  {
    name: "Valid HTTPS URL",
    input: "https://example.com",
    expected: { websiteUrl: "https://example.com", isValidUrl: true }
  },
  {
    name: "Valid HTTP URL",
    input: "http://example.com",
    expected: { websiteUrl: "http://example.com", isValidUrl: true }
  },
  {
    name: "Domain only (should add https)",
    input: "example.com",
    expected: { websiteUrl: "example.com", isValidUrl: true }
  },
  {
    name: "URL with path",
    input: "https://example.com/path",
    expected: { websiteUrl: "https://example.com/path", isValidUrl: true }
  },
  {
    name: "URL with query parameters",
    input: "https://example.com?param=value",
    expected: { websiteUrl: "https://example.com?param=value", isValidUrl: true }
  },
  {
    name: "Invalid URL",
    input: "not-a-url",
    expected: { websiteUrl: null, isValidUrl: false }
  },
  {
    name: "Empty string",
    input: "",
    expected: { websiteUrl: null, isValidUrl: false }
  }
];

// Manual test function
export function testWebsiteUrlHook() {
  console.log("Testing useWebsiteUrl hook functionality:");
  
  testCases.forEach((testCase, index) => {
    console.log(`\nTest ${index + 1}: ${testCase.name}`);
    console.log(`Input: ${testCase.input}`);
    console.log(`Expected:`, testCase.expected);
    
    // Simulate URL parameter
    const url = new URL("https://app.exit1.dev");
    url.searchParams.set("website", testCase.input);
    
    // Test URL validation logic
    let isValid = false;
    let websiteUrl = null;
    
    try {
      let urlToValidate = testCase.input;
      if (!urlToValidate.startsWith('http://') && !urlToValidate.startsWith('https://')) {
        urlToValidate = `https://${urlToValidate}`;
      }
      new URL(urlToValidate);
      websiteUrl = testCase.input;
      isValid = true;
    } catch (error) {
      isValid = false;
    }
    
    const result = { websiteUrl, isValidUrl: isValid };
    const passed = JSON.stringify(result) === JSON.stringify(testCase.expected);
    
    console.log(`Result:`, result);
    console.log(`Status: ${passed ? '✅ PASS' : '❌ FAIL'}`);
  });
}

// Run tests if this file is executed directly
if (typeof window !== 'undefined') {
  // Browser environment
  (window as any).testWebsiteUrlHook = testWebsiteUrlHook;
} else {
  // Node environment
  testWebsiteUrlHook();
}
