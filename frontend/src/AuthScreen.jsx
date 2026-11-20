import { useState } from 'react';
import { BACKEND_URL } from './socket';

const inputStyle = {
  padding: "10px 12px",
  borderRadius: "6px",
  border: "1px solid #555",
  background: "#111",
  color: "#fff",
  fontSize: "15px",
};

// The first screen: sign in, or switch to "Create account" to register. Both send the
// username and password to the server's sign-in routes, which reply with a ticket (JWT)
function AuthScreen({ notice, onSignedIn }) {
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(notice);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault(); // stop the browser reloading the page, which is what forms do by default
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${BACKEND_URL}/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error);
        return;
      }
      onSignedIn(result);
    } catch {
      setError("Can't reach the server — it may be starting up, try again in a moment");
    } finally {
      setBusy(false);
    }
  };

  const isLogin = mode === "login";
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#000", fontFamily: "sans-serif" }}>
      <form
        onSubmit={submit}
        style={{ width: "320px", display: "flex", flexDirection: "column", gap: "12px", background: "#151515", border: "1px solid #333", borderRadius: "10px", padding: "28px" }}
      >
        <h1 style={{ margin: "0 0 4px", color: "#fff", fontSize: "26px" }}>OurBoard</h1>
        <p style={{ margin: "0 0 8px", color: "#999", fontSize: "14px" }}>{isLogin ? "Sign in to your boards" : "Create an account"}</p>

        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" autoComplete="username" style={inputStyle} />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete={isLogin ? "current-password" : "new-password"}
          style={inputStyle}
        />

        {error && <div style={{ color: "#FF6B6B", fontSize: "13px" }}>{error}</div>}

        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          style={{ padding: "10px", borderRadius: "6px", border: "none", background: "#32D74B", color: "#000", fontWeight: "bold", fontSize: "15px", cursor: "pointer" }}
        >
          {busy ? "..." : isLogin ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(isLogin ? "register" : "login");
            setError(null);
          }}
          style={{ background: "none", border: "none", color: "#64D2FF", cursor: "pointer", fontSize: "13px" }}
        >
          {isLogin ? "No account yet? Create one" : "Already have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}

export default AuthScreen;
