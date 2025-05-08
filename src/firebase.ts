// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
// import { getAnalytics } from "firebase/analytics";

// TODO: Replace the following with your app's Firebase project configuration
const firebaseConfig = {
  apiKey: "AIzaSyA_u4HK3F83-oR-zmQhWtKa8_UVcpkXymc",
  authDomain: "errdev-efb37.firebaseapp.com",
  projectId: "errdev-efb37",
  storageBucket: "errdev-efb37.firebasestorage.app",
  messagingSenderId: "414779535693",
  appId: "1:414779535693:web:1c8ca28bb8f9f5dcf78704",
  measurementId: "G-6C2B2K1TZ4"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
// const analytics = getAnalytics(app);

const db = getFirestore(app);

export { db };

export default app; 