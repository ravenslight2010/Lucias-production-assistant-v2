import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function parseWorkspacePatterns(contents) {
  const lines = contents.split(/\r?\n/);
  const patterns = [];
  let inPackages = false;

  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }

    if (inPackages && /^\S/.test(line)) {
      break;
    }

    if (inPackages) {
      const match = line.match(/^\s+-\s+(.+?)\s*$/);
      if (match) patterns.push(match[1]);
    }
  }

  if (patterns.length === 0) {
    throw new Error("No workspace package patterns found in pnpm-workspace.yaml.");
  }
  return patterns;
}

function parseCatalog(contents) {
  const lines = contents.split(/\r?\n/);
  const catalog = new Map();
  const headerIndex = lines.findIndex((line) => /^catalog:\s*$/.test(line));

  if (headerIndex < 0) {
    throw new Error("The default pnpm catalog is missing from pnpm-workspace.yaml.");
  }

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break;

    const match = line.match(
      /^  (?:(['"])(.*?)\1|([^:]+)):\s*(\S.*)\s*$/,
    );
    if (!match) {
      throw new Error(`Could not parse pnpm catalog entry: ${line}`);
    }

    const name = (match[2] ?? match[3]).trim();
    if (catalog.has(name)) {
      throw new Error(`Duplicate pnpm catalog entry for ${name}.`);
    }
    catalog.set(name, match[4]);
  }

  return catalog;
}

function expandWorkspacePattern(root, pattern) {
  let paths = [root];
  for (const segment of pattern.split("/")) {
    if (segment === "*") {
      paths = paths.flatMap((parent) => {
        if (!fs.existsSync(parent)) return [];
        return fs
          .readdirSync(parent, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
          .map((entry) => path.join(parent, entry.name));
      });
    } else if (segment.includes("*") || segment.includes("{") || segment.includes("}")) {
      throw new Error(`Unsupported workspace package pattern: ${pattern}`);
    } else {
      paths = paths.map((parent) => path.join(parent, segment));
    }
  }
  return paths.filter((candidate) => fs.existsSync(candidate));
}

function readExceptions(root) {
  const exceptionPath = path.join(
    root,
    ".github",
    "dependency-catalog-exceptions.json",
  );
  if (!fs.existsSync(exceptionPath)) return {};
  return JSON.parse(fs.readFileSync(exceptionPath, "utf8"));
}

export function checkWorkspaceCatalog(root = process.cwd()) {
  const workspaceFile = path.join(root, "pnpm-workspace.yaml");
  const workspaceContents = fs.readFileSync(workspaceFile, "utf8");
  const catalog = parseCatalog(workspaceContents);
  const patterns = parseWorkspacePatterns(workspaceContents);
  const exceptions = readExceptions(root);
  const manifests = new Set();

  const rootManifest = path.join(root, "package.json");
  if (fs.existsSync(rootManifest)) manifests.add(rootManifest);

  for (const pattern of patterns) {
    for (const directory of expandWorkspacePattern(root, pattern)) {
      const manifest = path.join(directory, "package.json");
      if (fs.existsSync(manifest)) manifests.add(manifest);
    }
  }

  const occurrences = new Map();
  const issues = [];

  for (const manifestPath of [...manifests].sort()) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const section of dependencySections) {
      for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
        if (specifier === "catalog:" && !catalog.has(name)) {
          issues.push(
            `${path.relative(root, manifestPath)}: ${name} uses catalog: but is missing from the default catalog.`,
          );
        }
        if (specifier.startsWith("workspace:")) continue;

        const entries = occurrences.get(name) ?? [];
        entries.push({
          manifest: path.relative(root, manifestPath),
          section,
          specifier,
        });
        occurrences.set(name, entries);
      }
    }
  }

  for (const [name, entries] of occurrences) {
    if (entries.length < 2) continue;

    for (const entry of entries) {
      if (entry.specifier === "catalog:") continue;
      const reason = exceptions[name]?.[entry.section];
      if (typeof reason === "string" && reason.trim().length > 0) continue;

      issues.push(
        `${entry.manifest}: repeated dependency ${name} must use catalog: (found ${entry.specifier} in ${entry.section}).`,
      );
    }
  }

  return issues;
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const issues = checkWorkspaceCatalog();
    if (issues.length > 0) {
      console.error("Workspace dependency catalog check failed:");
      for (const issue of issues) console.error(`- ${issue}`);
      process.exitCode = 1;
    } else {
      console.log("Workspace dependency catalog check passed.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
