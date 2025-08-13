const { initializeApp } = require('firebase/app');
const { getFunctions, httpsCallable } = require('firebase/functions');

// Your Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  authDomain: "exit1-dev.firebaseapp.com",
  projectId: "exit1-dev",
  storageBucket: "exit1-dev.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const functions = getFunctions(app);

// Call the debug function
const debugEmailSettings = httpsCallable(functions, 'debugEmailSettings');

debugEmailSettings({})
  .then((result) => {
    console.log('Debug result:', JSON.stringify(result.data, null, 2));
  })
  .catch((error) => {
    console.error('Error:', error);
  });
