import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import Board from './models/Board.js';
import authRoutes from './routes/auth.js';
import { readToken } from './services/tokens.js';
import { generateDiagram, convertSketch, explainSelection } from './services/generateDiagram.js';

// Without this secret nobody could sign in, so stop straight away with a clear message
// instead of failing in a confusing way later
if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is missing — add it to backend/.env (or to Render's Environment settings)");
  process.exit(1);
}

const MAX_OWNED_BOARDS = 4;
const MIN_BOARD_PASSWORD_LENGTH = 4;
const BOARD_HASH_ROUNDS = 10;

// FRONTEND_URL is set in Render's dashboard once the frontend is deployed; localhost stays
// allowed too so local dev keeps working without needing that env var.
const allowedOrigins = ["http://localhost:5173"];
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

const app = express();
// Only our own frontend may call the sign-in routes from a browser
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());
app.use('/api/auth', authRoutes);

// Reads MONGODB_URI from .env and connects to your Atlas cluster
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection failed:", err.message));

const server = http.createServer(app);

// Set up Socket.io to allow real-time connections from your React frontend.
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  },
  // If a client's connection drops briefly (wifi blip, laptop sleep) and it reconnects
  // within 2 minutes, Socket.IO replays whatever shape:add/update/delete broadcasts it
  // missed while it was gone, so its canvas catches back up automatically
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
  },
});

// Every live connection must carry a valid sign-in ticket (JWT). Without one it's refused
// here, before any board event can run. The `data.reason` tells the browser this was a
// sign-in problem (go back to the sign-in screen), not just the server being unreachable
io.use((socket, next) => {
  try {
    socket.data.user = readToken(socket.handshake.auth?.token);
    next();
  } catch {
    const refused = new Error("Please sign in again");
    refused.data = { reason: "auth" };
    next(refused);
  }
});

// A board name as plain text, at most 40 characters — String(...) also blocks the
// NoSQL-injection trick described in routes/auth.js
const cleanBoardName = (value) => String(value ?? "").trim().slice(0, 40);

// What the boards screen needs to know about each board
const boardSummary = (board) => ({ name: board.boardId, updatedAt: board.updatedAt });

// Listen for users connecting to the whiteboard
io.on("connection", (socket) => {
  const userId = socket.data.user.id;
  console.log(`${socket.data.user.username} connected (${socket.id})`);

  // Moves this connection into a board's room, so it gets that board's live updates
  const enterBoard = (board) => {
    if (socket.data.boardId) socket.leave(socket.data.boardId);
    socket.data.boardId = board.boardId;
    socket.join(board.boardId);
  };

  // Every shape lifecycle event (create, move/resize, undo-delete) only reaches other
  // users on the SAME board — everyone's grouped into a Socket.IO room named after the
  // board they're currently on. Nothing is passed on before a board has been opened
  ["shape:add", "shape:update", "shape:delete"].forEach((event) => {
    socket.on(event, (payload) => {
      if (!socket.data.boardId) return;
      socket.to(socket.data.boardId).emit(event, payload);
    });
  });

  // The boards screen: boards this user owns (up to 4) and boards they joined with a password
  socket.on("board:list", async (callback) => {
    try {
      const [mine, shared] = await Promise.all([
        Board.find({ owner: userId }).select("boardId updatedAt").sort({ updatedAt: -1 }),
        Board.find({ members: userId }).select("boardId updatedAt").sort({ updatedAt: -1 }),
      ]);
      callback({ success: true, mine: mine.map(boardSummary), shared: shared.map(boardSummary), limit: MAX_OWNED_BOARDS });
    } catch (err) {
      console.error("board:list failed:", err.message);
      callback({ success: false, error: "Could not load your boards" });
    }
  });

  // Create a board with a password. The name must be free, and nobody can own more than 4
  socket.on("board:create", async ({ name, password } = {}, callback) => {
    try {
      const boardId = cleanBoardName(name);
      const boardPassword = String(password ?? "");
      if (!boardId) return callback({ success: false, error: "Give the board a name" });
      if (boardPassword.length < MIN_BOARD_PASSWORD_LENGTH) {
        return callback({ success: false, error: `The board password needs at least ${MIN_BOARD_PASSWORD_LENGTH} characters` });
      }
      if ((await Board.countDocuments({ owner: userId })) >= MAX_OWNED_BOARDS) {
        return callback({ success: false, error: `You already have ${MAX_OWNED_BOARDS} boards — delete one first` });
      }
      if (await Board.exists({ boardId })) return callback({ success: false, error: "That board name is taken" });

      const board = await Board.create({
        boardId,
        owner: userId,
        members: [],
        passwordHash: await bcrypt.hash(boardPassword, BOARD_HASH_ROUNDS),
      });
      enterBoard(board);
      callback({ success: true, boardId, shapes: [] });
    } catch (err) {
      // 11000 = MongoDB's "duplicate key": someone else took the name at the same moment
      if (err.code === 11000) return callback({ success: false, error: "That board name is taken" });
      console.error("board:create failed:", err.message);
      callback({ success: false, error: "Could not create the board" });
    }
  });

  // Open a board. Its owner and members go straight in; anyone else needs the board's
  // password once, then they're added as a member so it appears on their boards list
  socket.on("board:join", async ({ name, password } = {}, callback) => {
    try {
      const board = await Board.findOne({ boardId: cleanBoardName(name) });
      if (!board) return callback({ success: false, error: "No board with that name" });

      const isOwner = board.owner.equals(userId);
      const isMember = board.members.some((member) => member.equals(userId));
      if (!isOwner && !isMember) {
        if (!(await bcrypt.compare(String(password ?? ""), board.passwordHash))) {
          return callback({ success: false, error: "Wrong board password" });
        }
        // $addToSet adds them only if they aren't on the list already
        await Board.updateOne({ _id: board._id }, { $addToSet: { members: userId } });
      }
      enterBoard(board);
      callback({ success: true, boardId: board.boardId, shapes: board.shapes });
    } catch (err) {
      console.error("board:join failed:", err.message);
      callback({ success: false, error: "Could not open the board" });
    }
  });

  // Back to the boards screen: stop receiving this board's live updates
  socket.on("board:leave", () => {
    if (socket.data.boardId) socket.leave(socket.data.boardId);
    socket.data.boardId = null;
  });

  // Delete a board — only its owner can, which frees one of their 4 places. Anyone still
  // on it is told, so their screen goes back to the boards list
  socket.on("board:delete", async ({ name } = {}, callback) => {
    try {
      const boardId = cleanBoardName(name);
      const result = await Board.deleteOne({ boardId, owner: userId });
      if (result.deletedCount === 0) return callback({ success: false, error: "Only the board's owner can delete it" });
      io.to(boardId).emit("board:deleted");
      callback({ success: true });
    } catch (err) {
      console.error("board:delete failed:", err.message);
      callback({ success: false, error: "Could not delete the board" });
    }
  });

  // Save the open board to MongoDB (the Save button, and auto-save)
  socket.on("board:save", async (shapes, callback) => {
    try {
      if (!socket.data.boardId) return callback({ success: false, error: "No board is open" });
      if (!Array.isArray(shapes)) return callback({ success: false, error: "Nothing to save" });
      await Board.updateOne({ boardId: socket.data.boardId }, { shapes });
      callback({ success: true });
    } catch (err) {
      console.error("board:save failed:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // A user clicked Load — read the saved board back, hand it to them, and sync everyone
  // else on the same board too so the whole room shows the same loaded board
  socket.on("board:load", async (callback) => {
    try {
      if (!socket.data.boardId) return callback({ success: false, error: "No board is open" });
      const board = await Board.findOne({ boardId: socket.data.boardId });
      const shapes = board ? board.shapes : [];
      callback({ success: true, shapes });
      socket.to(socket.data.boardId).emit("board:sync", shapes);
    } catch (err) {
      console.error("board:load failed:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // A user typed a prompt and asked the AI to generate a diagram. The shapes go back only
  // to the requester, whose browser moves them into empty space on the board and then
  // shares them through the normal undo-tracked add flow — the same way Convert works
  socket.on("board:generate", async (prompt, callback) => {
    try {
      const shapes = await generateDiagram(prompt);
      callback({ success: true, shapes });
    } catch (err) {
      console.error("board:generate failed:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // A user selected some rough freehand shapes and asked the AI to clean them up into a
  // formatted diagram. Unlike board:generate, this doesn't broadcast here — the requester
  // swaps the shapes in locally via the existing undo/delete/add flow, which already
  // handles telling everyone else
  socket.on("board:convertSketch", async (payload, callback) => {
    try {
      const shapes = await convertSketch(payload);
      callback({ success: true, shapes });
    } catch (err) {
      console.error("board:convertSketch failed:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // A user selected part of the board and asked the AI to explain it — read-only, no
  // shapes are added or changed, just a plain-text answer sent back to whoever asked
  socket.on("board:explainSelection", async (payload, callback) => {
    try {
      const explanation = await explainSelection(payload);
      callback({ success: true, explanation });
    } catch (err) {
      console.error("board:explainSelection failed:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

// Render assigns its own PORT via env var; 5000 stays the local dev default
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});
