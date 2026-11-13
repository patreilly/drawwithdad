import { categoryById, categoryForPrompt, type Category } from "../config/categories";
import { checkPrompt, FRIENDLY_REFUSAL } from "../safety/textFilter";
import type { ImageRef, SourceId } from "../types";
import type { QueueQuery } from "./referenceQueue";

export interface SearchPlan {
  prompt: string;
  category?: Category;
  queries: QueueQuery[];
  strict: boolean;
  /** Free-text prompts can be widened by Ollama; category sessions are already varied. */
  expandable: boolean;
  /** Draw from this fixed set (e.g. saved pictures) instead of searching. Still safety-checked. */
  images?: ImageRef[];
}

export function savedPicturesPlan(images: ImageRef[]): SearchPlan {
  return { prompt: "My pictures", queries: [], strict: true, expandable: false, images };
}

export type PlanResult = { ok: true; plan: SearchPlan } | { ok: false; message: string };

const SPACE_WORDS = /\b(rocket|astronaut|space|planet|moon|shuttle|satellite|nasa|galaxy|nebula|mars|saturn|jupiter|telescope|jet)\b/i;
/** Prompts about people skip Wikimedia Commons, which has no safe-search of its own. */
const PEOPLE_WORDS = /\b(person|people|man|men|woman|women|girl|girls|boy|boys|kid|kids|child|children|baby|babies|lady|ladies|guy|guys|teen|teens|pose|poses|posing|portrait|portraits|face|faces|body|bodies|dancer|dancers|model|models|figure|human|humans|athlete|athletes)\b/i;
const SUBJECTS_PER_CATEGORY_SESSION = 4;

export function planSearch(input: { prompt?: string; categoryId?: string }, random: () => number = Math.random): PlanResult {
  const prompt = (input.prompt ?? "").trim().slice(0, 100);
  let category = categoryById(input.categoryId);

  if (!category) {
    if (!prompt) return { ok: false, message: "Type something to draw, or pick a category below." };
    const check = checkPrompt(prompt);
    if (!check.ok) return { ok: false, message: FRIENDLY_REFUSAL };
    category = check.redirectToPeople ? categoryById("people") : categoryForPrompt(prompt);
  }

  if (category) {
    const subjects = pickSome(category.subjects, SUBJECTS_PER_CATEGORY_SESSION, random);
    return {
      ok: true,
      plan: {
        prompt: prompt || category.label,
        category,
        queries: subjects.map((text) => ({ text, sources: category.sources })),
        strict: !!category.strict,
        expandable: false,
      },
    };
  }

  return {
    ok: true,
    plan: {
      prompt,
      queries: [{ text: prompt, sources: freePromptSources(prompt) }],
      // We can't know whether a free prompt involves people, so use the strict thresholds.
      strict: true,
      expandable: true,
    },
  };
}

function pickSome<T>(items: T[], n: number, random: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

function freePromptSources(prompt: string): SourceId[] {
  const sources: SourceId[] = PEOPLE_WORDS.test(prompt) ? ["openverse"] : ["commons", "openverse"];
  if (SPACE_WORDS.test(prompt)) sources.push("nasa");
  return sources;
}
