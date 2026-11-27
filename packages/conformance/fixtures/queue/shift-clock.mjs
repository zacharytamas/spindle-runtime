// Moves the wall clock of the process by SPINDLE_CLOCK_SHIFT_MS milliseconds. A test loads it before the command, to
// run an observer whose clock is wrong. Timers keep their own time.
const shift = Number(process.env.SPINDLE_CLOCK_SHIFT_MS ?? 0)
const real = Date.now
Date.now = () => real() + shift
