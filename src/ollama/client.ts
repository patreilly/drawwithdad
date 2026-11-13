import { findBlockedTerm } from "../safety/textFilter";

/**
 * Optional "smart search" using a local Ollama. It's never on the critical
 * path: the session starts with the plain prompt, and Ollama's extra queries
 * join the mix when they arrive.
 *
 * When the app is served from a domain (not localhost), Ollama must allow that
 * origin, e.g. `OLLAMA_ORIGINS=https://drawwithdad.example ollama serve`.
 */

export interface OllamaStatus {
  ok: boolean;
  models: string[];
  error?: string;
}

export async function ollamaStatus(baseUrl: string): Promise<OllamaStatus> {
  try {
    const res = await fetch(`${trim(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, models: [], error: `Ollama returned ${res.status}` };
    const data = (await res.json()) as { models?: { name: string }[] };
    return { ok: true, models: (data.models ?? []).map((m) => m.name) };
  } catch {
    return { ok: false, models: [], error: "Not reachable" };
  }
}

/** Uses the configured model, or the smallest-looking installed one. */
export function pickModel(configured: string, installed: string[]): string | null {
  if (configured) return configured;
  const text = installed.filter((m) => !/embed|vision|llava|moondream/i.test(m));
  const bySize = (m: string) => Number(m.match(/(\d+(?:\.\d+)?)b\b/i)?.[1] ?? 99);
  return text.sort((a, b) => bySize(a) - bySize(b))[0] ?? null;
}

export interface Expansion {
  safe: boolean;
  queries: string[];
}

const SYSTEM = `You help artists find photo references on a kid-friendly site.
Given what the user wants to draw, reply with JSON:
- "safe": false if the request is sexual, nude, violent, gory, hateful or otherwise not suitable for children; otherwise true.
- "queries": 3 to 5 short photo-search queries (2-4 words each) that would find clear, well-lit reference photos of that subject from different angles or close relatives of it. Plain nouns and adjectives only.`;

const SCHEMA = {
  type: "object",
  properties: {
    safe: { type: "boolean" },
    queries: { type: "array", items: { type: "string" } },
  },
  required: ["safe", "queries"],
};

export async function expandPrompt(baseUrl: string, model: string, prompt: string, timeoutMs = 15_000): Promise<Expansion> {
  const res = await fetch(`${trim(baseUrl)}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: SCHEMA,
      options: { temperature: 0.3 },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return parseExpansion(data.message?.content ?? "", prompt);
}

/** Model output is untrusted: validate shape, cap size, and run our own word filter over it. */
export function parseExpansion(content: string, prompt: string): Expansion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { safe: true, queries: [] };
  }
  const obj = parsed as { safe?: unknown; queries?: unknown };
  const safe = obj.safe !== false;
  const queries = Array.isArray(obj.queries)
    ? obj.queries
        .filter((q): q is string => typeof q === "string")
        .map((q) => q.replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim())
        .filter((q) => q && q.length <= 60 && q.split(" ").length <= 6 && !findBlockedTerm(q))
        .filter((q) => q.toLowerCase() !== prompt.trim().toLowerCase())
        .slice(0, 5)
    : [];
  return { safe, queries };
}

function trim(url: string): string {
  return url.replace(/\/+$/, "");
}
