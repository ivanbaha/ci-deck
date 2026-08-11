/**
 * `import … with { type: 'file' }` yields a path, which Bun rewrites to point
 * inside the executable when it compiles the file in — see src/binary.ts.
 *
 * Declared rather than resolved because `public/` is generated: a fresh clone
 * has none, and `bun run typecheck` has to pass there too. The imports go
 * through the `#built/*` subpath in package.json rather than a relative path
 * so that this declaration wins — bun-types declares `*.html` as an
 * `HTMLBundle`, and between two patterns TypeScript takes the longer prefix.
 */
declare module '#built/*' {
    const path: string;
    export default path;
}
