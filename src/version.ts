import pkg from '../package.json';

/**
 * Bundled in rather than read at runtime. A standalone binary has no
 * package.json beside it to read — and no package manager to ask either, which
 * is exactly why a downloaded copy has to be able to say what it is.
 */
export const VERSION: string = pkg.version;
