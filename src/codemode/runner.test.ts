import { describe, expect, it, vi } from "vitest";
import type { FileTools } from "../tools/files.js";
import { createCodeRunner } from "./runner.js";

function fakeTools(): FileTools {
  return {
    listFiles: vi.fn(async () => ["a.ts", "b.ts"]),
    readFile: vi.fn(async () => "content"),
  };
}

describe("createCodeRunner", () => {
  it("returns values passed to out and the returned value", async () => {
    const tools = fakeTools();
    const run = createCodeRunner(tools);

    const result = await run(
      "const files = await tools.listFiles();\nout(files.length);\nreturn await tools.readFile({ path: files[0] });",
    );

    expect(result).toEqual({ ok: true, output: "2\ncontent" });
    expect(tools.readFile).toHaveBeenCalledWith({ path: "a.ts" });
  });

  it("formats objects as JSON and maps console.log to out", async () => {
    const run = createCodeRunner(fakeTools());

    const result = await run('console.log("x", 1);\nout({ a: 1 });');

    expect(result).toEqual({ ok: true, output: 'x 1\n{\n  "a": 1\n}' });
  });

  it("reports when nothing is output", async () => {
    const run = createCodeRunner(fakeTools());

    expect(await run("const a = 1;")).toEqual({
      ok: true,
      output: "(no output)",
    });
  });

  it("strips a markdown code fence", async () => {
    const run = createCodeRunner(fakeTools());

    expect(await run("```js\nreturn 1;\n```")).toEqual({
      ok: true,
      output: "1",
    });
  });

  it("keeps output before an error", async () => {
    const run = createCodeRunner(fakeTools());

    const result = await run('out("before");\nthrow new TypeError("bad");');

    expect(result).toEqual({ ok: false, output: "before\nTypeError: bad" });
  });

  it("times out async code", async () => {
    const run = createCodeRunner(fakeTools(), 50);

    const result = await run("await new Promise(() => {});");

    expect(result).toEqual({
      ok: false,
      output: "Error: timed out after 50ms",
    });
  });

  it("truncates long output", async () => {
    const run = createCodeRunner(fakeTools());

    const result = await run('return "x".repeat(20010);');

    expect(result.output).toMatch(
      /\[truncated 10 characters; narrow the output\]$/,
    );
  });
});
