import * as fs from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface FileTools {
  listFiles(args?: { path?: string }): Promise<string[]>;
  readFile(args: {
    path: string;
    offset?: number;
    limit?: number;
  }): Promise<string>;
}

export interface FileSystem {
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<{ name: string; isDirectory(): boolean }[]>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

const ignored = new Set([".git", "node_modules"]);
export const maxEntries = 5000;

export function createFileTools(
  root: string,
  fileSystem: FileSystem = fs,
): FileTools {
  const inside = (path: string) => {
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`path is outside the working directory: ${path}`);
    }
    return absolute;
  };

  return {
    async listFiles(args = {}) {
      const start = inside(args.path ?? ".");
      const files: string[] = [];
      const walk = async (dir: string) => {
        const entries = await fileSystem.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (files.length >= maxEntries) return;
          if (ignored.has(entry.name)) continue;
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path);
          else files.push(relative(root, path));
        }
      };
      await walk(start);
      return files.sort();
    },

    async readFile({ path, offset = 1, limit }) {
      const text = await fileSystem.readFile(inside(path), "utf8");
      if (offset === 1 && limit === undefined) return text;
      const lines = text.split("\n");
      return lines
        .slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit)
        .join("\n");
    },
  };
}
