// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore, enableNetwork } from "firebase/firestore";
import { getFunctions } from "firebase/functions";
import { getAuth, setPersistence, browserLocalPersistence } from "firebase/auth";
// import { getAnalytics } from "firebase/analytics";

// Firebase project configuration for exit1.dev
const firebaseConfig = {
  apiKey: "AIzaSyBJj7oHBfYGiYh03LgyRaFWf0vQ-_h1rMI",
  authDomain: "exit1-dev.firebaseapp.com",
  projectId: "exit1-dev",
  storageBucket: "exit1-dev.firebasestorage.app",
  messagingSenderId: "118327018856",
  appId: "1:118327018856:web:d7545b23b8b4007db7c2dd",
  measurementId: "G-VDFWPHZBH1"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
// const analytics = getAnalytics(app);

// Initialize Firebase Auth with persistence
const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence);

const db = getFirestore(app);
const functions = getFunctions(app, 'us-central1');

// Enable network for optimal performance
enableNetwork(db);

export { db, functions, auth };

export default app; 