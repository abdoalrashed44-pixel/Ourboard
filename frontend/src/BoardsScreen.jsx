import { useEffect, useState } from 'react';
import { socket } from './socket';

const inputStyle = {
  padding: "8px 10px",
  borderRadius: "6px",
  border: "1px solid #555",
  background: "#111",
  color: "#fff",
  fontSize: "14px",
  flex: 1,
  minWidth: 0,
};
const buttonStyle = {
  padding: "8px 14px",
  borderRadius: "6px",
  border: "1px solid #666",
  background: "#1a1a1a",
  color: "#fff",
  cursor: "pointer",
  fontSize: "14px",
};
const sectionStyle = { background: "#151515", border: "1px solid #333", borderRadius: "10px", padding: "16px 18px" };
const headingStyle = { margin: "0 0 12px", color: "#fff", fontSize: "16px" };

// The screen between signing in and drawing: your boards (up to 4), boards shared with
// you, and forms to create a new board or join someone else's with its password
function BoardsScreen({ username, notice, onOpen, onSignOut }) {
  const [boards, setBoards] = useState(null); // { mine, shared, limit } once loaded
  const [reloadCount, setReloadCount] = useState(0); // bump to fetch the list again
  const [message, setMessage] = useState(notice);
  const [busy, setBusy] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joinPassword, setJoinPassword] = useState("");

  useEffect(() => {
    socket.emit("board:list", (response) => {
      if (response.success) setBoards(response);
      else setMessage(response.error);
    });
  }, [reloadCount]);

  // Opening a board you own, one shared with you, a brand-new one, or one joined by name
  // all end the same way: the server checks you're allowed in and sends back its shapes
  const openWith = (event, payload) => {
    setBusy(true);
    setMessage(null);
    socket.emit(event, payload, (response) => {
      setBusy(false);
      if (response.success) onOpen({ boardId: response.boardId, shapes: response.shapes });
      else setMessage(response.error);
    });
  };

  const deleteBoard = (name) => {
    if (!window.confirm(`Delete "${name}" for everyone? This can't be undone.`)) return;
    socket.emit("board:delete", { name }, (response) => {
      if (!response.success) setMessage(response.error);
      setReloadCount((count) => count + 1);
    });
  };

  const boardRow = (board, canDelete) => (
    <div key={board.name} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 0", borderTop: "1px solid #262626" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: "#fff", fontSize: "15px", overflow: "hidden", textOverflow: "ellipsis" }}>{board.name}</div>
        <div style={{ color: "#777", fontSize: "12px" }}>Last changed {new Date(board.updatedAt).toLocaleString()}</div>
      </div>
      <button onClick={() => openWith("board:join", { name: board.name })} disabled={busy} style={buttonStyle}>
        Open
      </button>
      {canDelete && (
        <button onClick={() => deleteBoard(board.name)} disabled={busy} style={{ ...buttonStyle, color: "#FF6B6B" }}>
          Delete
        </button>
      )}
    </div>
  );

  const atLimit = boards && boards.mine.length >= boards.limit;
  return (
    <div style={{ minHeight: "100vh", background: "#000", fontFamily: "sans-serif", padding: "32px 16px", boxSizing: "border-box" }}>
      <div style={{ maxWidth: "640px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <h1 style={{ margin: 0, color: "#fff", fontSize: "26px", flex: 1 }}>OurBoard</h1>
          <span style={{ color: "#999", fontSize: "14px" }}>Signed in as {username}</span>
          <button onClick={onSignOut} style={buttonStyle}>
            Sign out
          </button>
        </div>

        {message && <div style={{ color: "#FF6B6B", fontSize: "14px" }}>{message}</div>}

        <div style={sectionStyle}>
          <h2 style={headingStyle}>
            My boards {boards && `(${boards.mine.length} of ${boards.limit})`}
          </h2>
          {!boards && <div style={{ color: "#777" }}>Loading...</div>}
          {boards && boards.mine.length === 0 && <div style={{ color: "#777" }}>No boards yet — create one below.</div>}
          {boards && boards.mine.map((board) => boardRow(board, true))}
        </div>

        {boards && boards.shared.length > 0 && (
          <div style={sectionStyle}>
            <h2 style={headingStyle}>Shared with me</h2>
            {boards.shared.map((board) => boardRow(board, false))}
          </div>
        )}

        <form
          style={sectionStyle}
          onSubmit={(e) => {
            e.preventDefault();
            openWith("board:create", { name: createName, password: createPassword });
          }}
        >
          <h2 style={headingStyle}>Create a board</h2>
          {atLimit ? (
            <div style={{ color: "#777" }}>You have {boards.limit} boards, the most allowed — delete one to make a new one.</div>
          ) : (
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="Board name" style={inputStyle} />
              <input type="password" value={createPassword} onChange={(e) => setCreatePassword(e.target.value)} placeholder="Board password" style={inputStyle} />
              <button type="submit" disabled={busy || !createName.trim() || !createPassword} style={buttonStyle}>
                Create
              </button>
            </div>
          )}
        </form>

        <form
          style={sectionStyle}
          onSubmit={(e) => {
            e.preventDefault();
            openWith("board:join", { name: joinName, password: joinPassword });
          }}
        >
          <h2 style={headingStyle}>Join someone's board</h2>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <input value={joinName} onChange={(e) => setJoinName(e.target.value)} placeholder="Board name" style={inputStyle} />
            <input type="password" value={joinPassword} onChange={(e) => setJoinPassword(e.target.value)} placeholder="Board password" style={inputStyle} />
            <button type="submit" disabled={busy || !joinName.trim()} style={buttonStyle}>
              Join
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default BoardsScreen;
