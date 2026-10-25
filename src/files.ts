// Writing rendered diagrams to disk, safely: absolute paths only, optionally
// confined to one directory, and never overwriting an existing file.
import fs from "fs";
import path from "path";

export class OutputPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputPathError";
  }
}

// Legacy `name` parameter: plain file names only, no separators or dotfiles
const NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;

export function legacyOutputPath(name: string, folder: string, extension: string): string {
  if (!NAME_PATTERN.test(name)) throw new OutputPathError("Invalid name: use only letters, digits, '.', '_' and '-' (no path separators, must not start with '.')");
  if (!path.isAbsolute(folder)) throw new OutputPathError("Invalid folder: must be an absolute path");
  return path.join(path.resolve(folder), `${name}.${extension}`);
}

// Nearest existing ancestor, resolved through symlinks
function realAncestor(p: string): string {
  let current = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), path.relative(current, p));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      current = parent;
    }
  }
}

export interface WriteResult {
  path: string;
  renamed: boolean;
}

// Checks a requested output path and returns it normalized, before any work
// is done. `allowedDir`, when set, must contain the real location of the file.
export function resolveOutput(target: string, extension: string, allowedDir?: string): string {
  if (!path.isAbsolute(target)) throw new OutputPathError(`outputPath must be an absolute path, got "${target}"`);
  let resolved = path.resolve(target);
  const ext = path.extname(resolved).toLowerCase();
  if (ext && ext !== `.${extension}`) throw new OutputPathError(`outputPath ends in "${ext}" but the format is ${extension}; use a .${extension} file name`);
  if (!ext) resolved += `.${extension}`;
  if (allowedDir) {
    const root = realAncestor(path.resolve(allowedDir));
    const rel = path.relative(root, realAncestor(resolved));
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new OutputPathError(`outputPath must be inside ${allowedDir} (MERMAID_OUTPUT_DIR)`);
  }
  return resolved;
}

// Writes `data` at `target` (or a numbered sibling if `target` exists)
export function writeOutput(target: string, data: Uint8Array | string, extension: string, allowedDir?: string): WriteResult {
  const resolved = resolveOutput(target, extension, allowedDir);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const base = resolved.slice(0, -(extension.length + 1));
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? resolved : `${base}-${i}.${extension}`;
    try {
      // "wx" fails if anything exists there, symlinks included
      fs.writeFileSync(candidate, data, { flag: "wx" });
      return { path: candidate, renamed: i > 0 };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new OutputPathError(`Could not find a free file name next to ${resolved}`);
}
