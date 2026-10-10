/**
 * Exit-code contract shared by the test suites and the runner.
 *
 * Kept in its own module so a suite can import the constant without importing
 * `run.mjs` — importing the runner would execute it.
 *
 * @module dsh-mimo-connect/tests/exit-codes
 */

/**
 * Exit code a suite uses to report "there is nothing on this machine to check".
 *
 * Several suites need something the machine may not have — a DSH installation,
 * a signed-in MiMo desktop credential, a profile with the plugin installed —
 * and exiting 0 in that case was indistinguishable from having run and passed.
 * The runner counts this code as a *skip*: not a failure, but not evidence
 * either, so it is never folded into the pass count.
 *
 * Chosen above the codes the suites already use for real failures (1, 2, 3, 4)
 * so a skip can never be mistaken for a failing run.
 */
export const SKIP_EXIT_CODE = 10
