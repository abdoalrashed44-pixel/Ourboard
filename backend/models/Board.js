import mongoose from 'mongoose';

// Shapes stay a loosely-typed array on purpose, matching the single shared shape format
// described in CLAUDE.md (id, type, x, y, width, height, stroke, fill, points, text, ...).
// A strict per-field sub-schema would force every shape type into the same fixed fields,
// which is exactly the "second shape representation" that file says not to create.
//
// boardId is the board's name, unique across the whole app, so it's what people type to
// join. owner and members point at User documents: the owner created the board (and it
// counts toward their 4), members joined it with the board password once and can come
// back without typing it again. The board password is stored as a bcrypt hash, like
// account passwords.
const boardSchema = new mongoose.Schema(
  {
    boardId: { type: String, required: true, unique: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    passwordHash: { type: String, required: true },
    shapes: { type: Array, default: [] },
  },
  { timestamps: true }
);

export default mongoose.model('Board', boardSchema);
