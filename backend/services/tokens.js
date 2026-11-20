import jwt from 'jsonwebtoken';

// A JWT is a signed "ticket" saying who a user is. The server signs it with JWT_SECRET
// when they sign in; the browser sends it back with every connection, and the server
// checks the signature, so a ticket that was edited or made up is rejected
export function makeToken(user) {
  return jwt.sign({ userId: user._id.toString(), username: user.username }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });
}

// The user inside a ticket, or an error if the ticket is fake, edited or expired
export function readToken(token) {
  const { userId, username } = jwt.verify(String(token), process.env.JWT_SECRET);
  return { id: userId, username };
}
