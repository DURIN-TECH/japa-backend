/**
 * Re-vendor @durin-tech/authz into functions/vendor/authz from the sibling
 * seli-authz repo's built dist.
 *
 * Why vendoring: Firebase `firebase deploy --only functions` re-runs `npm install`
 * in Google's cloud build, which has no way to authenticate to the private GitHub
 * Packages registry. Shipping the package as a local `file:` dependency removes the
 * need for any credentials at build time.
 *
 * Run after the package changes (requires ../../seli-authz present + built):
 *   npm run vendor:authz   # or: node vendor-authz.cjs
 */
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../../seli-authz");
const DEST = path.resolve(__dirname, "vendor/authz");

const srcDist = path.join(SRC, "dist");
if (!fs.existsSync(srcDist)) {
  console.error(`Cannot vendor: ${srcDist} not found. Build seli-authz first (npm run build).`);
  process.exit(1);
}

// Replace the vendored dist with a fresh copy.
fs.rmSync(path.join(DEST, "dist"), { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
fs.cpSync(srcDist, path.join(DEST, "dist"), { recursive: true });

// Write a MINIMAL package.json — no scripts (avoids npm running a build on install)
// and no devDependencies. Keeps only what the resolver/runtime needs.
const pkg = require(path.join(SRC, "package.json"));
fs.writeFileSync(
  path.join(DEST, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      main: pkg.main,
      types: pkg.types,
      sideEffects: pkg.sideEffects,
      dependencies: pkg.dependencies,
    },
    null,
    2
  ) + "\n"
);

console.log(`Vendored ${pkg.name}@${pkg.version} → vendor/authz`);
