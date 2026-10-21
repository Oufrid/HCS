// Conversation snapshots: turn a chat export into an anchorable transcript that `compile` can read.

export interface Message {
  role: string;
  text: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const c = content as { parts?: unknown; text?: unknown };
    if (Array.isArray(c.parts)) return textOf(c.parts);
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

/**
 * Accepts the common shapes: `[{role, content}]`, `{messages: [...]}` (OpenAI/Anthropic style, content as
 * string or parts) and a single ChatGPT export conversation (`{mapping: {...}}`).
 */
export function parseConversation(json: unknown): Message[] {
  let list: unknown[] | undefined;
  if (Array.isArray(json)) {
    // A ChatGPT export file is an array of conversations; take the first if so.
    if (json.length && (json[0] as any)?.mapping) return parseConversation(json[0]);
    list = json;
  } else if (json && typeof json === "object") {
    const o = json as any;
    if (Array.isArray(o.messages)) list = o.messages;
    else if (Array.isArray(o.chat_messages)) list = o.chat_messages;
    else if (o.mapping && typeof o.mapping === "object") {
      list = Object.values(o.mapping)
        .map((n: any) => n?.message)
        .filter((m: any) => m && m.author)
        .sort((a: any, b: any) => (a.create_time ?? 0) - (b.create_time ?? 0))
        .map((m: any) => ({ role: m.author.role, content: m.content }));
    }
  }
  if (!list) throw new Error("unrecognized conversation format (expected an array of messages or {messages: [...]})");
  const out: Message[] = [];
  for (const m of list as any[]) {
    const role = String(m?.role ?? m?.sender ?? m?.author?.role ?? "unknown");
    const text = textOf(m?.content ?? m?.text).trim();
    if (text && role !== "system") out.push({ role, text });
  }
  if (!out.length) throw new Error("conversation contains no messages");
  return out;
}

export function toTranscript(messages: Message[], title: string): string {
  const parts = [`<!-- hcs:transcript -->`, `# ${title}`, ""];
  messages.forEach((m, i) => {
    parts.push(`### [${i + 1}] ${m.role}`, "", m.text, "");
  });
  return parts.join("\n");
}
