// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore, enableNetwork } from "firebase/firestore";
import { getFunctions } from "firebase/functions";
import { getAuth, setPersistence, browserLocalPersistence } from "firebase/auth";
import { getStorage } from "firebase/storage";
// import { getAnalytics } from "firebase/analytics";

// Firebase project configuration for exit1.dev
// Note: Firebase API keys are safe to expose in client-side code, but using env vars is best practice
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyBJj7oHBfYGiYh03LgyRaFWf0vQ-_h1rMI",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "exit1-dev.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "exit1-dev",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "exit1-dev.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "118327018856",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:118327018856:web:d7545b23b8b4007db7c2dd",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-VDFWPHZBH1"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
// const analytics = getAnalytics(app);

// Initialize Firebase Auth with persistence
const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence);

const db = getFirestore(app);
const functions = getFunctions(app, 'us-central1');
const storage = getStorage(app);

// Enable network for optimal performance
enableNetwork(db);

export { db, functions, auth, storage };

export default app; 
