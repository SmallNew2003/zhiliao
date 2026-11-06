/**
 * Isolate Vitest workers and inherited test subprocesses from the machine's memory daemon.
 * Port zero cannot name a listening TCP service. Tests with an owned HTTP fixture may
 * explicitly replace this value after the shared test configuration has loaded.
 * @module
 */
process.env.HINDSIGHT_API_URL = 'http://127.0.0.1:0'
