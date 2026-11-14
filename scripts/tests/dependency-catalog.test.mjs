import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkWorkspaceCatalog } from "../src/check-dependency-catalog.mjs";

function createWorkspace(t, { catalog = "shared: ^1.0.0", exceptions = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "packages", "one"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages", "two"), { recursive: true });
  fs.mkdirSync(path.join(root, ".github"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    `packages:\n  - packages/*\n\ncatalog:\n  ${catalog}\n`,
  );
  fs.writeFileSync(
    path.join(root, ".github", "dependency-catalog-exceptions.json"),
    JSON.stringify(exceptions),
  );

  return {
    root,
    writeManifest(directory, manifest) {
      fs.writeFileSync(
        path.join(root, "packages", directory, "package.json"),
        JSON.stringify(manifest),
      );
    },
  };
}

test("accepts catalog-managed duplicates and unique package dependencies", (t) => {
  const workspace = createWorkspace(t);
  workspace.writeManifest("one", {
    dependencies: { shared: "catalog:", unique: "^2.0.0" },
  });
  workspace.writeManifest("two", { devDependencies: { shared: "catalog:" } });

  assert.deepEqual(checkWorkspaceCatalog(workspace.root), []);
});

test("rejects repeated direct versions outside the catalog", (t) => {
  const workspace = createWorkspace(t);
  workspace.writeManifest("one", { dependencies: { shared: "^1.0.0" } });
  workspace.writeManifest("two", { dependencies: { shared: "^1.0.1" } });

  const issues = checkWorkspaceCatalog(workspace.root);
  assert.equal(issues.length, 2);
  assert.match(issues[0], /repeated dependency shared must use catalog:/);
});

test("checks shared dependencies declared by the workspace root", (t) => {
  const workspace = createWorkspace(t);
  fs.writeFileSync(
    path.join(workspace.root, "package.json"),
    JSON.stringify({ devDependencies: { shared: "^1.0.0" } }),
  );
  workspace.writeManifest("one", { dependencies: { shared: "catalog:" } });

  assert.match(checkWorkspaceCatalog(workspace.root)[0], /package.json: repeated dependency shared/);
});

test("rejects catalog references without a matching catalog entry", (t) => {
  const workspace = createWorkspace(t);
  workspace.writeManifest("one", { dependencies: { missing: "catalog:" } });
  workspace.writeManifest("two", {});

  assert.match(checkWorkspaceCatalog(workspace.root)[0], /missing from the default catalog/);
});

test("allows a documented peer dependency exception only in its section", (t) => {
  const workspace = createWorkspace(t, {
    catalog: "react: 19.3.1",
    exceptions: {
      react: {
        peerDependencies: "Libraries keep a broad peer range for consumer compatibility.",
      },
    },
  });
  workspace.writeManifest("one", { dependencies: { react: "catalog:" } });
  workspace.writeManifest("two", { peerDependencies: { react: ">=18" } });

  assert.deepEqual(checkWorkspaceCatalog(workspace.root), []);
});
