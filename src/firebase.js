import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "AIzaSyD0An3Un19xMa-vB4ewaUysnY0iIRlH5Wc",
  authDomain: "prosol-ca.firebaseapp.com",
  projectId: "prosol-ca",
  storageBucket: "prosol-ca.firebasestorage.app",
  messagingSenderId: "458894737935",
  appId: "1:458894737935:web:cce4e9b073e4d11155597a",
  measurementId: "G-KB8S5J2GFG"
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

export { app, analytics };
