import { Router } from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { makeToken } from '../services/tokens.js';

const router = Router();

// Usernames are 3–20 letters, numbers or underscores, stored in lower case so "Ali" and
// "ali" are the same account
const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 6;
// How much work bcrypt does per password. Higher is slower for attackers guessing
// passwords — and for us; 10 is the common default
const HASH_ROUNDS = 10;

// String(...) turns anything that isn't plain text — such as {"$ne": null}, a trick that
// makes a MongoDB query match any user ("NoSQL injection") — into harmless text first
function readCredentials(body) {
  return {
    username: String(body?.username ?? '').trim().toLowerCase(),
    password: String(body?.password ?? ''),
  };
}

// What the browser gets back after signing in: the ticket, plus who they are. The id is
// what new shapes record in their createdBy field
function signedInReply(user) {
  return { token: makeToken(user), username: user.username, userId: user._id.toString() };
}

router.post('/register', async (req, res) => {
  const { username, password } = readCredentials(req.body);
  if (!USERNAME_PATTERN.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–20 letters, numbers or _' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  try {
    if (await User.exists({ username })) {
      return res.status(409).json({ error: 'That username is taken' });
    }
    const user = await User.create({ username, passwordHash: await bcrypt.hash(password, HASH_ROUNDS) });
    res.json(signedInReply(user));
  } catch (err) {
    // 11000 = MongoDB's "duplicate key": two people registered the same name at once
    if (err.code === 11000) return res.status(409).json({ error: 'That username is taken' });
    console.error('register failed:', err.message);
    res.status(500).json({ error: 'Could not create the account' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = readCredentials(req.body);
  try {
    const user = await User.findOne({ username });
    // The same message whether the username or the password was wrong, so the form
    // can't be used to find out which usernames exist
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    res.json(signedInReply(user));
  } catch (err) {
    console.error('login failed:', err.message);
    res.status(500).json({ error: 'Could not sign in' });
  }
});

export default router;
