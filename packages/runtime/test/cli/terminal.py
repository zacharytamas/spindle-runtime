# Runs a command on a pseudo-terminal, for the chat tests that need a real terminal. Node has no pseudo-terminal of
# its own, and Python's is the same on macOS and Linux.
#
#   python3 terminal.py <command> [arguments]
#
# The bytes this script reads on its standard input are typed into the terminal. 0x03 is Ctrl-C and 0x04 is Ctrl-D,
# and the terminal decides what they mean, as it does for a person. Everything the command prints comes out on this
# script's standard output, standard error included, in the order the terminal showed it. The script exits with the
# command's exit code, or with 128 plus the signal number when a signal killed the command.
import fcntl
import os
import pty
import select
import struct
import sys
import termios


def main() -> int:
    pid, terminal = pty.fork()
    if pid == 0:
        os.execvp(sys.argv[1], sys.argv[1:])
    fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    keyboard = sys.stdin.fileno()
    watched = [terminal, keyboard]
    while terminal in watched:
        ready, _, _ = select.select(watched, [], [])
        if keyboard in ready:
            typed = os.read(keyboard, 4096)
            if typed:
                os.write(terminal, typed)
            else:
                watched.remove(keyboard)
        if terminal in ready:
            try:
                shown = os.read(terminal, 4096)
            except OSError:
                shown = b""
            if shown:
                os.write(sys.stdout.fileno(), shown)
            else:
                watched.remove(terminal)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status) if not os.WIFSIGNALED(status) else 128 + os.WTERMSIG(status)


if __name__ == "__main__":
    sys.exit(main())
