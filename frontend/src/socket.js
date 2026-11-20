import { io } from 'socket.io-client';
import { loadSession } from './session';

// VITE_BACKEND_URL is set in Vercel's dashboard once the backend is deployed; localhost
// stays the default so local dev keeps working without needing that env var.
export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";

// One live connection shared by every screen. It doesn't connect on its own: the app calls
// socket.connect() once someone has signed in, and each time it connects it hands the
// server their sign-in ticket so the server knows who they are
export const socket = io(BACKEND_URL, {
  autoConnect: false,
  auth: (send) => send({ token: loadSession()?.token }),
});
