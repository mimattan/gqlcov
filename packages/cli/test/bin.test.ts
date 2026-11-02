import { describe, expect, it, vi } from "vitest";

describe("gqlcov binary", () => {
  it("prints the error and exits with 2 when a command fails", async () => {
    const argv = process.argv;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.argv = ["node", "gqlcov", "gate", "/definitely/missing/report.json"];
    try {
      await import("../src/bin.js");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
      expect(error.mock.calls[0][0]).toMatch(/^gqlcov: ENOENT/);
    } finally {
      process.argv = argv;
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
