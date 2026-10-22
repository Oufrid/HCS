// Posts the `hcs impact` report on a pull request as one comment, updated on every push instead of duplicated.
// Uses the workflow's automatic GITHUB_TOKEN: no secret to configure.

import { readFileSync } from "node:fs";

export interface GitHubContext {
  api: string;
  token: string;
  repository: string;
  pullNumber: number;
}

/** Read the pull request from the Actions environment, or explain what is missing. */
export function githubContext(env: NodeJS.ProcessEnv = process.env): GitHubContext {
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  if (!token || !repository) throw new Error("posting a comment needs GITHUB_TOKEN and GITHUB_REPOSITORY (set by GitHub Actions)");
  let pullNumber = Number(env.HCS_PR_NUMBER);
  if (!pullNumber && env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    pullNumber = Number(event.pull_request?.number ?? event.number);
  }
  if (!pullNumber) throw new Error("no pull request number: run on a pull_request event, or set HCS_PR_NUMBER");
  return { api: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""), token, repository, pullNumber };
}

async function call(ctx: GitHubContext, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${ctx.api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 403 ? " (the workflow needs `permissions: pull-requests: write`; pull requests from forks get a read-only token)" : "";
    throw new Error(`GitHub API ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}${hint}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Create or update the comment that contains `marker`. With `onlyIfExists`, a report with nothing to say is not
 * posted on a pull request that never had one, but it does replace an earlier report.
 */
export async function upsertComment(ctx: GitHubContext, marker: string, body: string, onlyIfExists = false): Promise<"created" | "updated" | "skipped"> {
  let existing: { id: number } | undefined;
  for (let page = 1; page <= 20 && !existing; page++) {
    const comments: { id: number; body?: string }[] = await call(ctx, "GET", `/repos/${ctx.repository}/issues/${ctx.pullNumber}/comments?per_page=100&page=${page}`);
    existing = comments.find((c) => c.body?.includes(marker));
    if (comments.length < 100) break;
  }
  if (existing) {
    await call(ctx, "PATCH", `/repos/${ctx.repository}/issues/comments/${existing.id}`, { body });
    return "updated";
  }
  if (onlyIfExists) return "skipped";
  await call(ctx, "POST", `/repos/${ctx.repository}/issues/${ctx.pullNumber}/comments`, { body });
  return "created";
}
