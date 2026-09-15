import mongoose from 'mongoose';

// Shapes stay a loosely-typed array on purpose, matching the single shared shape format
// described in CLAUDE.md (id, type, x, y, width, height, stroke, fill, points, text, ...).
// A strict per-field sub-schema would force every shape type into the same fixed fields,
// which is exactly the "second shape representation" that file says not to create.
const boardSchema = new mongoose.Schema(
  {
    boardId: { type: String, required: true, unique: true },
    shapes: { type: Array, default: [] },
  },
  { timestamps: true }
);

export default mongoose.model('Board', boardSchema);
