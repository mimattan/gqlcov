import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentMarker, prFromEvent, upsertPrComment, type HttpLike } from "../src/github.js";

interface Call { method: string; url: string; body?: { body: string }; headers: Record<string, string> }

/** A fake GitHub API: pages of existing comments, and the status to answer writes with. */
function github(pages: { id: number; body?: string }[][], writeStatus = 201) {
  const calls: Call[] = [];
  const fetchImpl: HttpLike = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === "GET") {
      const page = Number(new URL(url).searchParams.get("page"));
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(pages[page - 1] ?? []) };
    }
    const ok = writeStatus < 300;
    return { ok, status: writeStatus, statusText: ok ? "OK" : "Nope", text: async () => (ok ? JSON.stringify({ html_url: "https://github.com/o/r/pull/7#c" }) : "") };
  };
  return { fetchImpl, calls };
}
const base = { token: "t", repo: "o/r", pr: 7 };
const GITHUB_ENV = ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_EVENT_PATH", "GITHUB_API_URL"];
const saved = { ...process.env };
// On GitHub Actions these point at the real run (a pull request event, a token); no test may read them by accident.
beforeEach(() => {
  for (const k of GITHUB_ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of GITHUB_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("upsertPrComment", () => {
  it("creates the comment with the marker when there is none", async () => {
    const g = github([[{ id: 1, body: "unrelated" }, { id: 2 }]]);
    const r = await upsertPrComment({ ...base, body: "hello", fetchImpl: g.fetchImpl });
    expect(r).toEqual({ action: "created", url: "https://github.com/o/r/pull/7#c" });
    expect(g.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://api.github.com/repos/o/r/issues/7/comments?per_page=100&page=1", "POST https://api.github.com/repos/o/r/issues/7/comments"]);
    expect(g.calls[1].body).toEqual({ body: "<!-- gqlcov -->\nhello" });
    expect(g.calls[0].headers).toMatchObject({ authorization: "Bearer t", "x-github-api-version": "2022-11-28" });
  });

  it("finds an earlier comment on a later page and updates it, keeping a body that already has the marker", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, body: "x" }));
    const g = github([full, [{ id: 555, body: `${commentMarker("api")}\nold` }]], 200);
    const r = await upsertPrComment({ ...base, id: "api", body: `${commentMarker("api")}\nnew`, fetchImpl: g.fetchImpl });
    expect(r.action).toBe("updated");
    expect(g.calls.at(-1)).toMatchObject({ method: "PATCH", url: "https://api.github.com/repos/o/r/issues/comments/555", body: { body: "<!-- gqlcov:api -->\nnew" } });
  });

  it("keeps separate comments per id", async () => {
    const g = github([[{ id: 9, body: "<!-- gqlcov -->\nmain report" }]]);
    expect((await upsertPrComment({ ...base, id: "web", body: "b", fetchImpl: g.fetchImpl })).action).toBe("created");
  });

  it("skips outside pull requests and when the token may not write", async () => {
    expect(await upsertPrComment({ body: "b", token: "t", repo: "o/r" })).toEqual({ action: "skipped", reason: "not a pull request" });
    const g = github([[]], 403);
    expect(await upsertPrComment({ ...base, body: "b", fetchImpl: g.fetchImpl })).toEqual({ action: "skipped", reason: "the token may not write comments on o/r#7 (a pull request from a fork?)" });
  });

  it("explains missing settings and failed calls", async () => {
    await expect(upsertPrComment({ body: "b", pr: 1 })).rejects.toThrow("GITHUB_TOKEN is not set");
    await expect(upsertPrComment({ body: "b", pr: 1, token: "t" })).rejects.toThrow("GITHUB_REPOSITORY is not set");
    const listFails: HttpLike = async () => ({ ok: false, status: 404, statusText: "Not Found", text: async () => "" });
    await expect(upsertPrComment({ ...base, body: "b", fetchImpl: listFails })).rejects.toThrow("listing comments on o/r#7 failed: 404 Not Found");
    const g = github([[]], 500);
    await expect(upsertPrComment({ ...base, body: "b", fetchImpl: g.fetchImpl })).rejects.toThrow("writing the comment on o/r#7 failed: 500 Nope");
  });

  it("reads the token, repository, pull request and API URL from the GitHub Actions environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gqlcov-gh-"));
    writeFileSync(join(dir, "event.json"), JSON.stringify({ pull_request: { number: 42 } }));
    Object.assign(process.env, { GITHUB_TOKEN: "env-token", GITHUB_REPOSITORY: "me/repo", GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_API_URL: "https://ghe.example/api/v3/" });
    const g = github([[]]);
    await upsertPrComment({ body: "b", fetchImpl: g.fetchImpl });
    expect(g.calls[0].url).toBe("https://ghe.example/api/v3/repos/me/repo/issues/42/comments?per_page=100&page=1");
    expect(g.calls[0].headers.authorization).toBe("Bearer env-token");
  });

  it("uses the global fetch by default", async () => {
    const saved = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, statusText: "OK", text: async () => (url.includes("comments?") ? "[]" : JSON.stringify({ html_url: "u" })) };
    }) as unknown as typeof fetch;
    try {
      expect(await upsertPrComment({ ...base, body: "b" })).toEqual({ action: "created", url: "u" });
      expect(urls).toHaveLength(2);
    } finally {
      globalThis.fetch = saved;
    }
  });
});

describe("prFromEvent", () => {
  it("reads pull request events and comments on pull requests, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "gqlcov-gh-"));
    const event = (name: string, body: unknown) => {
      writeFileSync(join(dir, name), JSON.stringify(body));
      return join(dir, name);
    };
    expect(prFromEvent(event("pr.json", { pull_request: { number: 3 } }))).toBe(3);
    expect(prFromEvent(event("comment.json", { issue: { number: 4, pull_request: {} } }))).toBe(4);
    expect(prFromEvent(event("issue.json", { issue: { number: 5 } }))).toBeUndefined();
    expect(prFromEvent(event("push.json", { ref: "refs/heads/main" }))).toBeUndefined();
    expect(prFromEvent()).toBeUndefined();
  });
});
