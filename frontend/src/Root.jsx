import { useEffect, useState } from 'react';
import App from './App.jsx';
import AuthScreen from './AuthScreen.jsx';
import BoardsScreen from './BoardsScreen.jsx';
import { socket } from './socket';
import { loadSession, saveSession, clearSession } from './session';

// Decides which of the three screens to show: sign in → choose a board → the whiteboard
// (App). It also connects the live socket only while someone is signed in
function Root() {
  const [session, setSession] = useState(loadSession); // { token, username, userId } or null
  const [board, setBoard] = useState(null); // { boardId, shapes } while a board is open
  const [notice, setNotice] = useState(null); // a message to show on the next screen

  useEffect(() => {
    if (!session) return;
    // The server refuses a connection whose ticket is fake or expired (after 7 days).
    // data.reason tells that apart from the server just being unreachable, which
    // shouldn't sign anyone out
    const onRefused = (err) => {
      if (err.data?.reason !== "auth") return;
      clearSession();
      setSession(null);
      setBoard(null);
      setNotice("Your sign-in has expired — please sign in again");
    };
    socket.on("connect_error", onRefused);
    socket.connect();
    return () => {
      socket.off("connect_error", onRefused);
      socket.disconnect();
    };
  }, [session]);

  if (!session) {
    return (
      <AuthScreen
        notice={notice}
        onSignedIn={(signedIn) => {
          saveSession(signedIn);
          setNotice(null);
          setSession(signedIn);
        }}
      />
    );
  }

  if (!board) {
    return (
      <BoardsScreen
        username={session.username}
        notice={notice}
        onOpen={(opened) => {
          setNotice(null);
          setBoard(opened);
        }}
        onSignOut={() => {
          clearSession();
          setSession(null);
        }}
      />
    );
  }

  // key={board.boardId}: opening a different board builds a fresh whiteboard, so undo
  // history, selection and so on never carry over from the previous board
  return (
    <App
      key={board.boardId}
      boardId={board.boardId}
      initialShapes={board.shapes}
      userId={session.userId}
      onLeaveBoard={(message) => {
        setNotice(message || null);
        setBoard(null);
      }}
    />
  );
}

export default Root;
