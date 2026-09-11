#!/usr/bin/env bun
/**
 * Build a Node-runnable npm package into `dist/`.
 *
 * Three things here are not obvious, and each one silently produced a broken
 * package before being handled:
 *
 * 1. `src/cli.ts` starts with `#!/usr/bin/env bun`. The bundler keeps it, so
 *    prepending a node shebang yields two — and the second one is a syntax
 *    error that only surfaces when the installed binary is executed.
 *
 * 2. `exec` hands pi a *file path* (`EXTENSION_PATH`) to load the extension
 *    from. Bundling only `cli.ts` leaves that path dangling: pi finds no
 *    extension, registers none of Para's tools, and `exec` still exits ok
 *    while the model answers from imagination. So `index.ts` must be emitted
 *    as its own entry, and cli must point at the built file.
 *
 * 3. pi loads the extension through jiti, which resolves `@earendil-works/*`
 *    and `typebox` BY PACKAGE NAME at runtime. Bundling them in does not help:
 *    jiti looks outside the bundle and fails with "Cannot find module
 *    'typebox'", pi records that error, registers zero Para tools, and exec
 *    used to answer from imagination anyway. So they stay external and remain
 *    real dependencies that npm installs.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolved by jiti at runtime, so they must not be inlined. */
const RUNTIME_EXTERNALS = [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"typebox",
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const run = (cmd: string[]) => {
	const p = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) {
		throw new Error(`${cmd.join(" ")} failed:\n${p.stderr.toString()}`);
	}
	return p.stdout.toString();
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// `index.ts` is a real entry, not dead weight: exec loads it by path at runtime.
console.log("building cli.js + index.js (target=node)…");
run([
	"bun",
	"build",
	"src/cli.ts",
	"src/index.ts",
	"--target=node",
	"--minify",
	"--outdir=dist",
	...RUNTIME_EXTERNALS.flatMap((p) => ["--external", p]),
]);

for (const f of ["cli.js", "index.js"]) {
	if (!existsSync(join(dist, f))) throw new Error(`expected dist/${f}`);
}

// Exactly one shebang, and it must say node.
const cliPath = join(dist, "cli.js");
let cli = readFileSync(cliPath, "utf8")
	.replace(/^#!.*\n/, "")
	.replace(/\n#!\/usr\/bin\/env bun\n/g, "\n");
if (cli.includes("#!/usr/bin/env bun")) throw new Error("bun shebang survived stripping");
cli = `#!/usr/bin/env node\n${cli}`;
writeFileSync(cliPath, cli, { mode: 0o755 });

// Point EXTENSION_PATH at the built extension instead of the absent .ts source.
const before = cli;
cli = cli.replace(/"\.\/index\.ts"/g, '"./index.js"').replace(/'\.\/index\.ts'/g, "'./index.js'");
if (cli === before) {
	console.warn("  note: no './index.ts' literal found; verifying resolution at runtime instead");
}
writeFileSync(cliPath, cli, { mode: 0o755 });

// Publish manifest: keep exactly the deps jiti resolves at runtime.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const allDeps = { ...pkg.dependencies };
for (const k of ["dependencies", "devDependencies", "private", "scripts"]) delete pkg[k];
pkg.dependencies = Object.fromEntries(
	RUNTIME_EXTERNALS.map((name) => {
		const range = allDeps[name];
		if (!range) throw new Error(`${name} is external but missing from package.json dependencies`);
		return [name, range];
	}),
);
pkg.bin = { para: "./cli.js" };
pkg.files = ["cli.js", "index.js", "README.md"];
pkg.engines = { node: ">=18" };
pkg.type = pkg.type ?? "module";
writeFileSync(join(dist, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(join(dist, "README.md"), readFileSync(join(root, "README.md")));

// Pack from dist/, where the publish manifest lives — packing the repo root
// would publish the source tree and the dev manifest instead.
const packOut = Bun.spawnSync(["npm", "pack", "--silent", "--pack-destination", root], {
	cwd: dist,
	stdout: "pipe",
	stderr: "pipe",
});
if (packOut.exitCode !== 0) throw new Error(`npm pack failed:\n${packOut.stderr.toString()}`);
const tgz = packOut.stdout.toString().trim().split("\n").pop();
console.log(`\npackage: ${tgz}`);
