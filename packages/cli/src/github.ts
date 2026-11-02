import { readFileSync } from "node:fs";

export type HttpLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

export interface CommentOptions {
  body: string;
  /** Default GITHUB_TOKEN. */
  token?: string;
  /** "owner/name". Default GITHUB_REPOSITORY. */
  repo?: string;
  /** Pull request number. Default: read from the event payload at GITHUB_EVENT_PATH. */
  pr?: number;
  /** Several reports on one pull request each keep their own comment. */
  id?: string;
  /** Default GITHUB_API_URL, else https://api.github.com. */
  api?: string;
  fetchImpl?: HttpLike;
}

export type CommentResult = { action: "created" | "updated"; url: string } | { action: "skipped"; reason: string };

/** The hidden marker that identifies gqlcov's comment, so later runs edit it instead of adding another. */
export const commentMarker = (id?: string) => `<!-- gqlcov${id ? `:${id}` : ""} -->`;

/** The pull request number of the current GitHub Actions event, if the event belongs to one. */
export function prFromEvent(path = process.env.GITHUB_EVENT_PATH): number | undefined {
  if (!path) return undefined;
  const event = JSON.parse(readFileSync(path, "utf8")) as { pull_request?: { number?: number }; issue?: { number?: number; pull_request?: unknown }; number?: number };
  return event.pull_request?.number ?? (event.issue?.pull_request ? event.issue.number : undefined);
}

/**
 * Create gqlcov's comment on a pull request, or update it when an earlier run left one. A token that may not
 * write (pull requests from forks) skips with a reason instead of failing the build.
 */
export async function upsertPrComment(o: CommentOptions): Promise<CommentResult> {
  const pr = o.pr ?? prFromEvent();
  if (!pr) return { action: "skipped", reason: "not a pull request" };
  const token = o.token ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set: pass --token or set the env variable (the Action passes github.token)");
  const repo = o.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is not set: pass --repo owner/name");
  const api = (o.api ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const doFetch = o.fetchImpl ?? (fetch as unknown as HttpLike);
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "gqlcov", "content-type": "application/json" };
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await doFetch(`${api}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { res, json: text ? (JSON.parse(text) as unknown) : undefined };
  };

  const marker = commentMarker(o.id);
  const body = o.body.includes(marker) ? o.body : `${marker}\n${o.body}`;
  let existing: { id: number } | undefined;
  for (let page = 1; !existing; page++) {
    const { res, json } = await call("GET", `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    if (!res.ok) throw new Error(`GitHub: listing comments on ${repo}#${pr} failed: ${res.status} ${res.statusText}`);
    const comments = json as { id: number; body?: string }[];
    existing = comments.find((c) => c.body?.includes(marker));
    if (comments.length < 100) break;
  }
  const { res, json } = existing ? await call("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body }) : await call("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
  if (res.status === 403) return { action: "skipped", reason: `the token may not write comments on ${repo}#${pr} (a pull request from a fork?)` };
  if (!res.ok) throw new Error(`GitHub: writing the comment on ${repo}#${pr} failed: ${res.status} ${res.statusText}`);
  return { action: existing ? "updated" : "created", url: (json as { html_url: string }).html_url };
}
