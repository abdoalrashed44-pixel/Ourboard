import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mongoose from 'mongoose';
import Board from './models/Board.js';
import { generateDiagram, convertSketch, explainSelection } from './services/generateDiagram.js';

// Everyone lands on this shared board by default, same as before board rooms existed —
// picking a different one is opt-in via board:join
const DEFAULT_BOARD_ID = 'main';

const app = express();
app.use(cors());

// Reads MONGODB_URI from .env and connects to your Atlas cluster
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection failed:", err.message));

const server = http.createServer(app);

// Set up Socket.io to allow real-time connections from your React frontend.
// FRONTEND_URL is set in Render's dashboard once the frontend is deployed; localhost stays
// allowed too so local dev keeps working without needing that env var.
const allowedOrigins = ["http://localhost:5173"];
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

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

// Listen for users connecting to the whiteboard
io.on("connection", (socket) => {
  console.log(`A user connected with ID: ${socket.id}`);

  // A recovered reconnect already has its previous board's room (and socket.data, which
  // holds boardId) restored automatically by Socket.IO's connection state recovery — only
  // a genuinely fresh connection needs to be placed on the default board and handed its
  // already-drawn shapes, so joining late doesn't mean landing on a blank canvas
  if (!socket.recovered) {
    socket.data.boardId = DEFAULT_BOARD_ID;
    socket.join(DEFAULT_BOARD_ID);
    Board.findOne({ boardId: DEFAULT_BOARD_ID })
      .then((board) => {
        socket.emit("board:init", { boardId: DEFAULT_BOARD_ID, shapes: board ? board.shapes : [] });
      })
      .catch((err) => console.error("board:init lookup failed:", err.message));
  }

  // Every shape lifecycle event (create, move/resize, undo-delete) only reaches other
  // users on the SAME board — everyone's grouped into a Socket.IO room named after the
  // board they're currently on
  ["shape:add", "shape:update", "shape:delete"].forEach((event) => {
    socket.on(event, (payload) => {
      socket.to(socket.data.boardId).emit(event, payload);
    });
  });

  // A user typed a board name and asked to switch to it — creating it if it doesn't exist
  // yet. Leaves whatever board they were on, joins the new one, and hands back its saved
  // shapes so switching feels like actually opening that board, not a blank canvas
  socket.on("board:join", async (boardId, callback) => {
    try {
      const id = String(boardId || "").trim();
      if (!id) {
        callback({ success: false, error: "Board name can't be empty" });
        return;
      }
      const board = await Board.findOne({ boardId: id });
      socket.leave(socket.data.boardId);
      socket.data.boardId = id;
      socket.join(id);
      callback({ success: true, boardId: id, shapes: board ? board.shapes : [] });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // A user clicked Save — write the current board to MongoDB and tell them if it worked
  socket.on("board:save", async (shapes, callback) => {
    try {
      await Board.findOneAndUpdate(
        { boardId: socket.data.boardId },
        { shapes },
        { upsert: true }
      );
      callback({ success: true });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // A user clicked Load — read the saved board back, hand it to them, and sync everyone
  // else on the same board too so the whole room shows the same loaded board
  socket.on("board:load", async (callback) => {
    try {
      const board = await Board.findOne({ boardId: socket.data.boardId });
      const shapes = board ? board.shapes : [];
      callback({ success: true, shapes });
      socket.to(socket.data.boardId).emit("board:sync", shapes);
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // A user typed a prompt and asked the AI to generate a diagram. The new shapes get
  // broadcast to everyone else on the same board exactly like hand-drawn ones — same
  // "shape:add" event — and handed back to the requester directly so their own canvas
  // picks them up too
  socket.on("board:generate", async (prompt, callback) => {
    try {
      const shapes = await generateDiagram(prompt);
      shapes.forEach((shape) => socket.to(socket.data.boardId).emit("shape:add", shape));
      callback({ success: true, shapes });
    } catch (err) {
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
