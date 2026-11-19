import { describe, expect, it, vi } from "vitest";
import { createFileTools, type FileSystem } from "./files.js";

const dirent = (name: string, dir = false) => ({
  name,
  isDirectory: () => dir,
});

function fakeFs(): FileSystem {
  const tree: Record<string, ReturnType<typeof dirent>[]> = {
    "/root": [
      dirent("b.ts"),
      dirent("src", true),
      dirent(".git", true),
      dirent("node_modules", true),
    ],
    "/root/src": [dirent("a.ts")],
  };
  return {
    readdir: vi.fn(async (path: string) => tree[path] ?? []),
    readFile: vi.fn(async () => "1\n2\n3\n4"),
  };
}

describe("createFileTools", () => {
  it("lists files recursively and skips ignored directories", async () => {
    const fs = fakeFs();
    const tools = createFileTools("/root", fs);

    expect(await tools.listFiles()).toEqual(["b.ts", "src/a.ts"]);
    expect(fs.readdir).not.toHaveBeenCalledWith(
      "/root/.git",
      expect.anything(),
    );
  });

  it("lists files under a sub directory", async () => {
    const tools = createFileTools("/root", fakeFs());

    expect(await tools.listFiles({ path: "src" })).toEqual(["src/a.ts"]);
  });

  it("reads a whole file", async () => {
    const fs = fakeFs();
    const tools = createFileTools("/root", fs);

    expect(await tools.readFile({ path: "b.ts" })).toBe("1\n2\n3\n4");
    expect(fs.readFile).toHaveBeenCalledWith("/root/b.ts", "utf8");
  });

  it("reads a line range", async () => {
    const tools = createFileTools("/root", fakeFs());

    expect(await tools.readFile({ path: "b.ts", offset: 2, limit: 2 })).toBe(
      "2\n3",
    );
  });

  it("rejects paths outside the root", async () => {
    const tools = createFileTools("/root", fakeFs());

    await expect(tools.readFile({ path: "../etc/passwd" })).rejects.toThrow(
      "outside",
    );
    await expect(tools.listFiles({ path: "/etc" })).rejects.toThrow("outside");
  });
});
