import { initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';

const firebaseConfig = {
  apiKey: "AIzaSyBvQvQvQvQvQvQvQvQvQvQvQvQvQvQvQvQ",
  authDomain: "exit1-dev.firebaseapp.com",
  projectId: "exit1-dev",
  storageBucket: "exit1-dev.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};

const app = initializeApp(firebaseConfig);
const functions = getFunctions(app);
const clearRdapCache = httpsCallable(functions, 'clearRdapCache');

console.log('Clearing RDAP cache...');
clearRdapCache()
  .then((result) => {
    console.log('Cache cleared successfully:', result.data);
  })
  .catch((error) => {
    console.error('Error clearing cache:', error);
  });

