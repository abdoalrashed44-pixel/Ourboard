# Claude Code project memory

These are Claude Code's project notes for OurBoard. They live outside the repo
by default, so they are copied here to travel with `git clone`.

## Restoring them on a new machine

Copy the four `.md` files (not this README) into Claude Code's project memory
folder for wherever you cloned the repo. The folder name is derived from the
project's full path, with separators replaced by `-`:

    C:\Users\<you>\.claude\projects\c--Users-<you>-Desktop-Ourboard\memory\

Create the `memory` folder if it does not exist. Claude loads `MEMORY.md` as the
index each session and reads the others on demand.

## Keeping them in sync

These copies do not update automatically. After a session where Claude's notes
changed, copy them back into `docs/claude-memory/` and commit.
