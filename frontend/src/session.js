// Remembers who is signed in, in the browser's localStorage, so a page refresh doesn't
// sign you out. Holds the sign-in ticket (JWT), the username and the user's id
const SESSION_KEY = "ourboard-session";

export function loadSession() {
  const saved = localStorage.getItem(SESSION_KEY);
  return saved ? JSON.parse(saved) : null;
}

export function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}
