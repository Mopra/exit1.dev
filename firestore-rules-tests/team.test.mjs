import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { collection, query, where, getDocs, doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

const rules = readFileSync(process.argv[2], 'utf8');
const env = await initializeTestEnvironment({
  projectId: 'demo-team',
  firestore: { rules, host: '127.0.0.1', port: 8085 },
});

const OWNER = 'user_owner';
const EDITOR = 'user_editor';
const VIEWER = 'user_viewer';
const STRANGER = 'user_stranger';
const FREEOWNER = 'user_freeowner';

await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'users', OWNER), { tier: 'pro' });
  await setDoc(doc(db, 'users', FREEOWNER), { tier: 'nano' });
  await setDoc(doc(db, 'teamMembers', `${OWNER}_${EDITOR}`), { ownerUid: OWNER, memberUid: EDITOR, role: 'editor' });
  await setDoc(doc(db, 'teamMembers', `${OWNER}_${VIEWER}`), { ownerUid: OWNER, memberUid: VIEWER, role: 'viewer' });
  await setDoc(doc(db, 'teamMembers', `${FREEOWNER}_${EDITOR}`), { ownerUid: FREEOWNER, memberUid: EDITOR, role: 'editor' });
  for (let i = 0; i < 3; i++) {
    await setDoc(doc(db, 'checks', `c${i}`), { userId: OWNER, url: 'https://a.com', name: 'abc', createdAt: 1, updatedAt: 1 });
  }
  await setDoc(doc(db, 'checks', 'f1'), { userId: FREEOWNER, url: 'https://a.com', name: 'abc', createdAt: 1, updatedAt: 1 });
  await setDoc(doc(db, 'webhooks', 'w1'), { userId: OWNER, url: 'https://a.com', name: 'hook', enabled: true, events: ['x'], createdAt: 1, updatedAt: 1 });
  await setDoc(doc(db, 'apiKeys', 'k1'), { userId: OWNER, hash: 'h', prefix: 'p', last4: '1234', enabled: true, createdAt: 1 });
  await setDoc(doc(db, 'emailSettings', OWNER), { recipients: [] });
  await setDoc(doc(db, 'status_pages', 'sp1'), { userId: OWNER, name: 'page', visibility: 'private', checkIds: [], createdAt: 1, updatedAt: 1 });
});

const as = (uid) => env.authenticatedContext(uid).firestore();
const q = (db, owner) => getDocs(query(collection(db, 'checks'), where('userId', '==', owner)));
let failures = 0;
async function t(name, p, expect) {
  try {
    await (expect ? assertSucceeds(p) : assertFails(p));
    console.log('ok  ', name);
  } catch (e) {
    failures++;
    console.log('FAIL', name, e.message);
  }
}

await t('owner lists own checks', q(as(OWNER), OWNER), true);
await t('editor lists owner checks', q(as(EDITOR), OWNER), true);
await t('viewer lists owner checks', q(as(VIEWER), OWNER), true);
await t('stranger cannot list owner checks', q(as(STRANGER), OWNER), false);
await t('member of non-pro owner cannot list', q(as(EDITOR), FREEOWNER), false);
await t('unfiltered list denied for member', getDocs(collection(as(EDITOR), 'checks')), false);
await t('editor get check', getDoc(doc(as(EDITOR), 'checks', 'c0')), true);
await t('viewer get check', getDoc(doc(as(VIEWER), 'checks', 'c0')), true);
await t('editor updates check', updateDoc(doc(as(EDITOR), 'checks', 'c0'), { name: 'renamed', updatedAt: 2 }), true);
await t('viewer cannot update check', updateDoc(doc(as(VIEWER), 'checks', 'c0'), { name: 'nope', updatedAt: 2 }), false);
await t('editor cannot move check to self', updateDoc(doc(as(EDITOR), 'checks', 'c0'), { userId: EDITOR }), false);
await t('editor creates check in owner account', setDoc(doc(as(EDITOR), 'checks', 'new1'), { userId: OWNER, url: 'https://b.com', name: 'new', createdAt: 1, updatedAt: 1 }), true);
await t('viewer cannot create check', setDoc(doc(as(VIEWER), 'checks', 'new2'), { userId: OWNER, url: 'https://b.com', name: 'new', createdAt: 1, updatedAt: 1 }), false);
await t('stranger cannot create check in owner account', setDoc(doc(as(STRANGER), 'checks', 'new3'), { userId: OWNER, url: 'https://b.com', name: 'new', createdAt: 1, updatedAt: 1 }), false);
await t('viewer cannot delete check', deleteDoc(doc(as(VIEWER), 'checks', 'c1')), false);
await t('editor deletes check', deleteDoc(doc(as(EDITOR), 'checks', 'c1')), true);
await t('stranger cannot update webhook (old hole)', updateDoc(doc(as(STRANGER), 'webhooks', 'w1'), { url: 'https://evil.com', name: 'hook', enabled: true, events: ['x'], updatedAt: 2 }), false);
await t('editor updates webhook', updateDoc(doc(as(EDITOR), 'webhooks', 'w1'), { url: 'https://ok.com', name: 'hook', enabled: true, events: ['x'], updatedAt: 2 }), true);
await t('stranger cannot toggle api key (old hole)', updateDoc(doc(as(STRANGER), 'apiKeys', 'k1'), { enabled: false }), false);
await t('owner toggles api key', updateDoc(doc(as(OWNER), 'apiKeys', 'k1'), { enabled: false }), true);
await t('viewer reads emailSettings', getDoc(doc(as(VIEWER), 'emailSettings', OWNER)), true);
await t('stranger cannot read emailSettings', getDoc(doc(as(STRANGER), 'emailSettings', OWNER)), false);
await t('viewer lists status pages', getDocs(query(collection(as(VIEWER), 'status_pages'), where('userId', '==', OWNER))), true);
await t('editor reads own memberships', getDocs(query(collection(as(EDITOR), 'teamMembers'), where('memberUid', '==', EDITOR))), true);
await t('owner reads team', getDocs(query(collection(as(OWNER), 'teamMembers'), where('ownerUid', '==', OWNER))), true);
await t('stranger cannot read team', getDocs(query(collection(as(STRANGER), 'teamMembers'), where('ownerUid', '==', OWNER))), false);
await t('member cannot write membership', setDoc(doc(as(VIEWER), 'teamMembers', `${OWNER}_${VIEWER}`), { ownerUid: OWNER, memberUid: VIEWER, role: 'editor' }), false);

// removal is instant
await env.withSecurityRulesDisabled(async (ctx) => {
  await deleteDoc(doc(ctx.firestore(), 'teamMembers', `${OWNER}_${VIEWER}`));
});
await t('removed viewer loses access', q(as(VIEWER), OWNER), false);
// downgrade is instant
await env.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), 'users', OWNER), { tier: 'nano' });
});
await t('editor loses access on owner downgrade', q(as(EDITOR), OWNER), false);
await t('owner keeps access after downgrade', q(as(OWNER), OWNER), true);

await env.cleanup();
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
