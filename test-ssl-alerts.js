// Test script for SSL alerts
// This script can be used to test SSL certificate validation and alerting

const testSSLCertificates = [
  {
    name: 'Valid Certificate',
    url: 'https://www.google.com',
    expectedValid: true
  },
  {
    name: 'Expired Certificate (test)',
    url: 'https://expired.badssl.com',
    expectedValid: false
  },
  {
    name: 'Self-Signed Certificate (test)',
    url: 'https://self-signed.badssl.com',
    expectedValid: false
  }
];

console.log('SSL Certificate Test Results:');
console.log('=============================');

// This would be used in a real test environment
// For now, this is just a reference for what to test

testSSLCertificates.forEach(test => {
  console.log(`\n${test.name}:`);
  console.log(`  URL: ${test.url}`);
  console.log(`  Expected Valid: ${test.expectedValid}`);
  console.log(`  Status: ${test.expectedValid ? '✅ Should trigger SSL warning if expiring soon' : '❌ Should trigger SSL error'}`);
});

console.log('\nSSL Alert Types:');
console.log('================');
console.log('1. SSL Error: Invalid, expired, or connection issues');
console.log('2. SSL Warning: Certificate expiring within 30 days');
console.log('\nBoth will trigger:');
console.log('- Email notifications (if configured)');
console.log('- Webhook notifications (if configured)');
console.log('- Include detailed certificate information');
