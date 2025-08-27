// Enhanced test script for domain expiry with DNS validation
const { initializeApp } = require('firebase/app');
const { getFunctions, httpsCallable } = require('firebase/functions');

// Firebase config (you'll need to add your config here)
const firebaseConfig = {
  // Add your Firebase config here
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const functions = getFunctions(app);

// Test domain expiry function
async function testDomainExpiry() {
  try {
    console.log('Testing enhanced domain expiry functionality...');
    
    // You'll need to replace 'YOUR_CHECK_ID' with an actual check ID from your database
    const debugDomainExpiry = httpsCallable(functions, 'debugDomainExpiry');
    
    const result = await debugDomainExpiry({ checkId: 'YOUR_CHECK_ID' });
    console.log('Debug result:', result.data);
    
  } catch (error) {
    console.error('Error testing domain expiry:', error);
  }
}

// Test with a specific URL
async function testWithUrl() {
  try {
    console.log('Testing with specific URL...');
    
    // Test the manual check function
    const manualCheck = httpsCallable(functions, 'manualCheck');
    
    // Replace 'YOUR_CHECK_ID' with an actual check ID
    const result = await manualCheck({ checkId: 'YOUR_CHECK_ID' });
    console.log('Manual check result:', result.data);
    
  } catch (error) {
    console.error('Error testing manual check:', error);
  }
}

// Test RDAP validation directly
async function testRDAPValidation() {
  try {
    console.log('Testing RDAP validation...');
    
    const testUrls = [
      'https://google.com',
      'https://example.com',
      'https://github.com',
      'https://stackoverflow.com',
      'https://nonexistent-domain-12345.com',
      'https://localhost:3000',
      'https://192.168.1.1',
      'https://app.foo.co.uk', // Test subdomain extraction
      'https://test.中国' // Test IDN
    ];
    
    for (const url of testUrls) {
      console.log(`\nTesting: ${url}`);
      // You can test the manual check function with these URLs
      // const manualCheck = httpsCallable(functions, 'manualCheck');
      // const result = await manualCheck({ checkId: 'YOUR_CHECK_ID' });
      // console.log('Result:', result.data);
    }
    
  } catch (error) {
    console.error('Error testing RDAP validation:', error);
  }
}

// Run tests
// testDomainExpiry();
// testWithUrl();
// testRDAPValidation();

console.log('Enhanced test script ready. Uncomment the test functions and add your Firebase config to run tests.');
console.log('New features:');
console.log('- RDAP integration for real expiry dates');
console.log('- DNS resolution validation (IPv4/IPv6)');
console.log('- PSL-based domain extraction');
console.log('- IDN support (punycode)');
console.log('- Intelligent caching');
console.log('- Enhanced error handling');
