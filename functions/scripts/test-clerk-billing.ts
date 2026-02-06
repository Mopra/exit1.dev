import { createClerkClient } from '@clerk/backend';
import dotenv from 'dotenv';
dotenv.config();

const secretKey = process.env.CLERK_SECRET_KEY;
if (!secretKey) {
  console.error('No CLERK_SECRET_KEY in .env');
  process.exit(1);
}

// A user confirmed to be nano in Clerk UI
const testUid = 'user_37skVmfeifBLgtV9aLVWhFRtAmL';

async function test() {
  const client = createClerkClient({ secretKey });

  console.log('Calling client.billing.getUserBillingSubscription...');
  const subscription: unknown = await client.billing.getUserBillingSubscription(testUid);

  console.log('\n=== RAW RESPONSE ===');
  console.log(JSON.stringify(subscription, null, 2));

  console.log('\n=== TYPE ===');
  console.log('type:', typeof subscription);

  if (subscription && typeof subscription === 'object') {
    const sub = subscription as Record<string, unknown>;
    console.log('top-level keys:', Object.keys(sub));

    if ('subscriptionItems' in sub) {
      console.log('\nsubscriptionItems:', JSON.stringify(sub.subscriptionItems, null, 2));
    } else {
      console.log('\nNO subscriptionItems key found!');
      // Check for other common shapes
      for (const key of Object.keys(sub)) {
        if (key.toLowerCase().includes('item') || key.toLowerCase().includes('plan') || key.toLowerCase().includes('sub')) {
          console.log(`  ${key}:`, JSON.stringify(sub[key], null, 2));
        }
      }
    }
  }
}

test().catch(e => {
  console.error('Error:', e.message);
  console.error('Full error:', JSON.stringify(e, null, 2));
});
