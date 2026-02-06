import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ projectId: 'exit1-dev' });
const db = getFirestore();

const users = [
  'user_37skVmfeifBLgtV9aLVWhFRtAmL',
  'user_35VCWtZecOsCknOVtzDhjr6miZJ',
  'user_38qSJ2C70gg0q4yjrznfcJ78NX4',
  'user_35hzf4OXehl9Lb4vuKZFqmn8TZp',
  'user_37xC0HeRHAejzf8GUFJ69DvHD5I',
];

async function run() {
  for (const uid of users) {
    const doc = await db.collection('users').doc(uid).get();
    const data = doc.data() || {};
    const updatedAt = data.tierUpdatedAt;
    const ageMin = updatedAt ? Math.round((Date.now() - updatedAt) / (60 * 1000)) : null;
    console.log(`${uid}:`);
    console.log(`  tier: ${data.tier}`);
    console.log(`  tierUpdatedAt: ${updatedAt ? new Date(updatedAt).toISOString() : 'never'}`);
    console.log(`  cache age: ${ageMin != null ? ageMin + ' minutes' : 'n/a'}`);
    console.log();
  }
}

run().catch(console.error);
