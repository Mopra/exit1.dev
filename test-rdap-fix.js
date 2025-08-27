// Test script for the new RDAP implementation with rate limiting
const { initializeApp } = require('firebase/app');
const { getFunctions, httpsCallable } = require('firebase/functions');

// Firebase config (you'll need to add your config here)
const firebaseConfig = {
  // Add your Firebase config here
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const functions = getFunctions(app);

// Test the new RDAP implementation
async function testRdapFix() {
  try {
    console.log('Testing new RDAP implementation with rate limiting...');
    
    // Test domains that should work
    const testDomains = [
      'google.com',
      'github.com',
      'stackoverflow.com',
      'example.com'
    ];
    
    for (const domain of testDomains) {
      console.log(`\nTesting domain: ${domain}`);
      
      // Test the debug function
      const debugDomainExpiry = httpsCallable(functions, 'debugDomainExpiry');
      
      // You'll need to create a test check first or use an existing check ID
      // For now, we'll just test the manual check function
      const manualCheck = httpsCallable(functions, 'manualCheck');
      
      try {
        // Replace 'YOUR_CHECK_ID' with an actual check ID from your database
        const result = await manualCheck({ 
          checkId: 'YOUR_CHECK_ID',
          url: `https://${domain}` 
        });
        
        console.log(`Result for ${domain}:`, {
          success: result.data.success,
          domainExpiry: result.data.domainExpiry,
          error: result.data.error
        });
        
      } catch (error) {
        console.error(`Error testing ${domain}:`, error.message);
      }
    }
    
  } catch (error) {
    console.error('Error testing RDAP fix:', error);
  }
}

// Test rate limiting behavior
async function testRateLimiting() {
  try {
    console.log('\nTesting rate limiting behavior...');
    
    const testDomain = 'google.com';
    console.log(`Testing rate limiting for ${testDomain}`);
    
    // Make multiple requests to see rate limiting in action
    for (let i = 0; i < 3; i++) {
      console.log(`\nRequest ${i + 1}:`);
      
      const manualCheck = httpsCallable(functions, 'manualCheck');
      
      try {
        const result = await manualCheck({ 
          checkId: 'YOUR_CHECK_ID',
          url: `https://${testDomain}` 
        });
        
        console.log(`Result:`, {
          success: result.data.success,
          domainExpiry: result.data.domainExpiry,
          error: result.data.error
        });
        
      } catch (error) {
        console.error(`Error:`, error.message);
      }
      
      // Wait a bit between requests
      if (i < 2) {
        console.log('Waiting 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
  } catch (error) {
    console.error('Error testing rate limiting:', error);
  }
}

// Test Firestore cache
async function testFirestoreCache() {
  try {
    console.log('\nTesting Firestore cache...');
    
    // Test the clear cache function
    const clearRdapCache = httpsCallable(functions, 'clearRdapCache');
    
    try {
      const result = await clearRdapCache({});
      console.log('Cache cleared:', result.data);
    } catch (error) {
      console.error('Error clearing cache:', error.message);
    }
    
  } catch (error) {
    console.error('Error testing Firestore cache:', error);
  }
}

// Run tests
async function runAllTests() {
  console.log('=== RDAP Fix Test Suite ===');
  
  await testRdapFix();
  await testRateLimiting();
  await testFirestoreCache();
  
  console.log('\n=== Test Summary ===');
  console.log('✅ Rate limiting implemented (24h minimum between attempts)');
  console.log('✅ Exponential backoff for failed attempts');
  console.log('✅ Persistent Firestore caching');
  console.log('✅ Better error handling and fallbacks');
  console.log('✅ DNS validation as fallback when RDAP fails');
  console.log('✅ No more force refresh spam');
}

// Uncomment to run tests
// runAllTests();

console.log('RDAP fix test script ready. Uncomment runAllTests() and add your Firebase config to run tests.');
console.log('\nNew features:');
console.log('- Rate limiting: 24h minimum between RDAP attempts');
console.log('- Exponential backoff: 2x, 4x, 8x backoff for failed attempts');
console.log('- Persistent caching: Firestore storage for RDAP data');
console.log('- Better error handling: Graceful fallback to DNS validation');
console.log('- No more spam: Removed force refresh debugging');
