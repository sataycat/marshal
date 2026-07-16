import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuildAppOptions } from "./http.js";
import { EventBus } from "./bus.js";
import type {
  Agent,
  AgentEvent,
  AgentId,
  AgentSession,
  PromptOptions,
  SpawnOptions,
} from "../agent/types.js";
import { openDb } from "../db/index.js";
import {
  extractMarshalSpec,
  renderSpecAuthoringPrompt,
  selectRecentHistory,
  MARSHAL_SPEC_FENCE,
  DEFAULT_SPEC_CHAT_BUDGET_CHARS,
  collectAgentText,
} from "./spec-chat.js";

function initGitRepo(root: string): void {
  execSync("git init -b main", { cwd: root, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: root, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "# Test\n");
  execSync("git add README.md", { cwd: root, stdio: "ignore" });
  execSync("git commit -m init", { cwd: root, stdio: "ignore" });
}

async function req(
  app: ReturnType<typeof buildApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit & { headers: Record<string, string> } = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(path, init);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    // keep raw text
  }
  return { status: res.status, body: parsed };
}

class FakeSpecAgent implements Agent {
  spawnCalls: { cwd: string; agentId: AgentId; opts: SpawnOptions }[] = [];
  promptCalls: { session: AgentSession; text: string; opts: PromptOptions }[] = [];
  closeCalls: AgentSession[] = [];
  constructor(private events: AgentEvent[]) {}

  async spawn(cwd: string, agentId: AgentId, opts: SpawnOptions = {}): Promise<AgentSession> {
    this.spawnCalls.push({ cwd, agentId, opts });
    return { agentId, cwd, name: opts.sessionName ?? `marshal-${agentId}`, recordId: "fake-rec" };
  }

  async *prompt(
    session: AgentSession,
    text: string,
    opts: PromptOptions = {},
  ): AsyncGenerator<AgentEvent> {
    this.promptCalls.push({ session, text, opts });
    for (const ev of this.events) yield ev;
  }

  async cancel(): Promise<void> {}

  async close(session: AgentSession): Promise<void> {
    this.closeCalls.push(session);
  }
}

describe("extractMarshalSpec", () => {
  it("extracts a single marshal-spec block", () => {
    const text = [
      "Here are gaps...\n",
      "```" + MARSHAL_SPEC_FENCE,
      "# Goal",
      "Do a thing.",
      "```",
      "",
      "Wrap up.",
    ].join("\n");
    const extracted = extractMarshalSpec(text);
    expect(extracted).toBe("# Goal\nDo a thing.");
  });

  it("returns null when no marshal-spec block exists", () => {
    expect(extractMarshalSpec("just prose\n```ts\ncode\n```")).toBeNull();
  });

  it("ignores an unclosed fence", () => {
    expect(extractMarshalSpec("```" + MARSHAL_SPEC_FENCE + "\nnever closed")).toBeNull();
  });

  it("ignores other code blocks with different info strings", () => {
    const text = "```js\nconst x = 1;\n```\n```" + MARSHAL_SPEC_FENCE + "\n## Goal\nDo it.\n```";
    expect(extractMarshalSpec(text)).toBe("## Goal\nDo it.");
  });
});

describe("collectAgentText", () => {
  it("concatenates text events", () => {
    const events: AgentEvent[] = [
      { type: "text", text: "hello " },
      { type: "thinking", text: "ignored" },
      { type: "text", text: "world" },
    ];
    expect(collectAgentText(events)).toBe("hello world");
  });

  it("throws on an error event", () => {
    const events: AgentEvent[] = [{ type: "error", message: "boom" }];
    expect(() => collectAgentText(events)).toThrow(/boom/);
  });
});

describe("selectRecentHistory", () => {
  function msg(id: number, content: string): SpecMessageLike {
    return {
      id,
      task_id: 1,
      role: "user",
      content,
      created_at: new Date(Date.now() + id).toISOString(),
    };
  }

  it("returns all messages when under budget", () => {
    const history = [msg(1, "a"), msg(2, "b")];
    expect(selectRecentHistory(history, 10_000).map((m) => m.id)).toEqual([1, 2]);
  });

  it("truncates from the oldest to fit the budget", () => {
    const history = [msg(1, "a".repeat(100)), msg(2, "b".repeat(100)), msg(3, "c")];
    const recent = selectRecentHistory(history, 20);
    expect(recent.map((m) => m.id)).toEqual([3]);
  });

  it("respects positive budget including all of small history", () => {
    const history = [msg(1, "a")];
    expect(selectRecentHistory(history, DEFAULT_SPEC_CHAT_BUDGET_CHARS)).toHaveLength(1);
  });
});

interface SpecMessageLike {
  id: number;
  task_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

describe("renderSpecAuthoringPrompt", () => {
  it("includes task title, spec draft, and the marshal-spec contract hint", () => {
    const task = { title: "Add thing", spec_markdown: "## Goal\nDo it.\n", status: "backlog" };
    const prompt = renderSpecAuthoringPrompt(task, []);
    expect(prompt).toContain("Add thing");
    expect(prompt).toContain("## Goal\nDo it.");
    expect(prompt).toContain(MARSHAL_SPEC_FENCE);
    expect(prompt).toContain("no messages yet");
  });

  it("includes recent chat history newest to oldest", () => {
    const task = { title: "t", spec_markdown: "", status: "backlog" };
    const history: SpecMessageLike[] = [
      { id: 1, task_id: 1, role: "user", content: "first", created_at: "2026-01-01T00:00:00.000Z" },
      {
        id: 2,
        task_id: 1,
        role: "assistant",
        content: "second",
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ];
    const prompt = renderSpecAuthoringPrompt(task, history);
    expect(prompt).toContain("first");
    expect(prompt).toContain("second");
  });

  it("warns when history is truncated", () => {
    const task = { title: "t", spec_markdown: "", status: "backlog" };
    const big = "x".repeat(DEFAULT_SPEC_CHAT_BUDGET_CHARS + 100);
    const history: SpecMessageLike[] = [
      { id: 1, task_id: 1, role: "user", content: big, created_at: "2026-01-01T00:00:00.000Z" },
      {
        id: 2,
        task_id: 1,
        role: "assistant",
        content: "recent",
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ];
    const prompt = renderSpecAuthoringPrompt(task, history);
    expect(prompt).toContain("older message(s) omitted");
  });
});

describe("spec chat HTTP contract", () => {
  let repoRoot: string;
  let app: ReturnType<typeof buildApp>;
  let options: BuildAppOptions;
  let bus: EventBus;
  let agent: FakeSpecAgent;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-spec-api-"));
    const worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-spec-api-wt-"));
    initGitRepo(repoRoot);
    mkdirSync(join(repoRoot, ".marshal"), { recursive: true });
    // ADR-023: specAuthor must be configured — resolveAgentId throws on missing.
    const cfgDir = mkdtempSync(join(tmpdir(), "marshal-spec-api-cfg-"));
    const cfgPath = join(cfgDir, "config.json");
    process.env.MARSHAL_GLOBAL_CONFIG = cfgPath;
    writeFileSync(
      cfgPath,
      JSON.stringify({
        agents: { specAuthor: { id: "opencode", command: "opencode", args: ["acp"] } },
      }),
    );
    bus = new EventBus();
    agent = new FakeSpecAgent([
      { type: "text", text: "Here are gaps...\n\n" },
      {
        type: "text",
        text: "```" + MARSHAL_SPEC_FENCE + "\n# Goal\nRefined.\n```",
      },
      { type: "done", stopReason: "end_turn" },
    ]);
    options = { root: repoRoot, worktreeRoot, bus, specAgent: agent };
    app = buildApp("0.0.1", options);
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  async function createBacklogTask(title: string, spec = ""): Promise<string> {
    const created = await req(app, "POST", "/api/tasks", { title, spec_markdown: spec });
    return (created.body as { task: { slug: string } }).task.slug;
  }

  it("returns an empty list for a backlog task with no messages", async () => {
    const slug = await createBacklogTask("Empty");
    const res = await req(app, "GET", `/api/tasks/${slug}/spec-messages`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [] });
  });

  it("stores the user message and the assistant reply, broadcasting two spec.message events", async () => {
    const slug = await createBacklogTask("Chat me");
    const seen: string[] = [];
    bus.subscribe((ev) => {
      seen.push(ev.type);
    });

    const res = await req(app, "POST", `/api/tasks/${slug}/spec-messages`, {
      content: "What about retries?",
    });
    expect(res.status).toBe(201);
    const body = res.body as {
      userMessage: { role: string; content: string };
      assistantMessage: { role: string; content: string };
    };
    expect(body.userMessage.role).toBe("user");
    expect(body.userMessage.content).toBe("What about retries?");
    expect(body.assistantMessage.role).toBe("assistant");
    expect(body.assistantMessage.content).toContain(MARSHAL_SPEC_FENCE);

    expect(seen.filter((t) => t === "spec.message")).toHaveLength(2);

    const list = await req(app, "GET", `/api/tasks/${slug}/spec-messages`);
    const messages = (list.body as { messages: { role: string; content: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("rejects chat on a non-backlog task with 409 spec_chat_closed", async () => {
    const slug = await createBacklogTask("Frozen soon", "## Goal\nShip.\n");
    await req(app, "POST", `/api/tasks/${slug}/ready`, {});
    const res = await req(app, "POST", `/api/tasks/${slug}/spec-messages`, { content: "hi" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "spec_chat_closed" });
  });

  it("rejects an empty content with 422", async () => {
    const slug = await createBacklogTask("Blank");
    const res = await req(app, "POST", `/api/tasks/${slug}/spec-messages`, { content: "   " });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "invalid_field" });
  });

  it("rejects an unknown field with 400", async () => {
    const slug = await createBacklogTask("Strict");
    const res = await req(app, "POST", `/api/tasks/${slug}/spec-messages`, {
      content: "hi",
      extra: "no",
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "unknown_field" });
  });

  it("returns 404 for unknown task spec-messages", async () => {
    const res = await req(app, "GET", "/api/tasks/ghost/spec-messages");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "task_not_found" });
  });

  it("POST /spec replaces spec_markdown and broadcasts task.updated", async () => {
    const slug = await createBacklogTask("Author me", "draft");
    const types: string[] = [];
    bus.subscribe((ev) => types.push(ev.type));
    const res = await req(app, "POST", `/api/tasks/${slug}/spec`, {
      spec_markdown: "## Goal\nAuthored.\n",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ task: { spec_markdown: "## Goal\nAuthored.\n" } });
    expect(types).toContain("task.updated");

    const db = openDb(repoRoot);
    const row = db.prepare("SELECT spec_markdown FROM tasks WHERE slug = ?").get(slug) as {
      spec_markdown: string;
    };
    expect(row.spec_markdown).toBe("## Goal\nAuthored.\n");
  });

  it("POST /spec rejects empty spec with 422", async () => {
    const slug = await createBacklogTask("Blank spec");
    const res = await req(app, "POST", `/api/tasks/${slug}/spec`, { spec_markdown: "   " });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "invalid_field" });
  });

  it("POST /spec on a non-backlog task is rejected with spec_chat_closed", async () => {
    const slug = await createBacklogTask("Already frozen", "## Goal\nHi.\n");
    await req(app, "POST", `/api/tasks/${slug}/ready`, {});
    const res = await req(app, "POST", `/api/tasks/${slug}/spec`, { spec_markdown: "nope" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "spec_chat_closed" });
  });

  it("marks the acceptance flow: chat, update spec, freeze to ready", async () => {
    const slug = await createBacklogTask("Slice Nine");

    const chat = await req(app, "POST", `/api/tasks/${slug}/spec-messages`, {
      content: "Tighten the spec.",
    });
    expect(chat.status).toBe(201);
    const assistant = (
      chat.body as {
        assistantMessage: { content: string };
      }
    ).assistantMessage.content;
    const block = extractMarshalSpec(assistant);
    expect(block, "assistant must include a marshal-spec block").not.toBeNull();

    const updated = await req(app, "POST", `/api/tasks/${slug}/spec`, { spec_markdown: block });
    expect(updated.status).toBe(200);

    const froze = await req(app, "POST", `/api/tasks/${slug}/ready`, {});
    expect(froze.status).toBe(200);
    expect(froze.body).toMatchObject({ task: { slug, status: "ready" } });
  });
});
