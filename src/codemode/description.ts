import { maxEntries } from "../tools/files.js";

export const maxOutputChars = 20000;

export const runCodeDescription = `Run JavaScript as the body of a fresh async function: top-level await and return work. Nothing persists between runs.
Only values passed to out() and the returned value are shown to you. Output over ${maxOutputChars} characters is truncated.
Do independent work in one run with Promise.all, and filter or aggregate in code before out().

declare const tools: {
  // Paths are relative to the working directory. Lists files recursively, skipping .git and node_modules. At most ${maxEntries} entries.
  listFiles(args?: { path?: string }): Promise<string[]>;
  // offset is a 1-based line number, limit is a number of lines.
  readFile(args: { path: string; offset?: number; limit?: number }): Promise<string>;
};
declare function out(value: unknown): void;`;
