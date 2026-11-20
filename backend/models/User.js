import mongoose from 'mongoose';

// One document per account. Only a bcrypt hash of the password is stored — a scrambled
// version that can be checked against a password typed later but can't be turned back
// into the password, so even someone reading the database never sees real passwords
const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);

export default mongoose.model('User', userSchema);
