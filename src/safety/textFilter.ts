/**
 * Layer 1 safety: a fast local word filter for prompts and image metadata
 * (titles and tags). It matches whole words after normalizing, so "class"
 * doesn't trip on "ass" and "Sussex" doesn't trip on "sex".
 *
 * This list is kept short on purpose. The image classifier is the main gate.
 * The list catches obvious intent early and cleans up metadata.
 */

const BLOCKED_WORDS = [
  // Nudity / sexual
  "nude", "nudes", "nudity", "naked", "nsfw", "porn", "porno", "pornography", "sex", "sexy",
  "sexual", "erotic", "erotica", "hentai", "lingerie", "bikini", "bikinis", "topless",
  "bottomless", "undressed", "undress", "undressing", "stripper", "striptease", "boobs",
  "tits", "nipple", "nipples", "genitals", "genital", "penis", "vagina", "fetish", "bdsm",
  "xxx", "onlyfans", "playboy", "prostitute", "seductive", "sensual", "lewd", "thong",
  "panties", "underwear", "bra", "boudoir", "pinup", "busty", "skinny dipping", "pin up",
  "nudist", "nudism", "naturist",
  // Gore / violence
  "gore", "gory", "blood", "bloody", "corpse", "corpses", "cadaver", "dead body",
  "murder", "killing", "suicide", "self harm", "torture", "decapitated", "beheaded",
  "beheading", "mutilated", "mutilation", "wound", "wounds", "wounded", "autopsy",
  "massacre", "execution", "dismembered", "carcass", "roadkill",
  // Modern weapons
  "gun", "guns", "rifle", "rifles", "pistol", "pistols", "firearm", "firearms", "shotgun",
  "handgun", "ak47", "assault rifle", "ammo", "ammunition",
  // Drugs, alcohol, tobacco
  "cocaine", "heroin", "meth", "marijuana", "cannabis", "weed", "drugs", "bong",
  "beer", "wine", "vodka", "whiskey", "alcohol", "drunk", "cigarette", "cigarettes",
  "cigar", "smoking", "vape", "vaping",
  // Hate & horror
  "nazi", "swastika", "kkk", "horror",
];

/**
 * Extra words checked only in image metadata (titles, tags, categories), where
 * they signal unsuitable pictures but would be too blunt for prompts.
 */
const METADATA_ONLY_WORDS = [
  "dead", "death", "deceased", "killed", "hunting", "hunted", "hunter", "slaughter", "slaughtered",
  "butchered", "butchery", "taxidermy", "injured", "injuries", "accident", "crash", "war", "warfare",
  "battle", "soldiers", "weapon", "weapons", "explicit", "adult", "medical", "surgery", "anatomy",
  "underwear", "swimwear", "swimsuit", "lingerie",
];

/**
 * Terms artists use for figure drawing. These are often nude in public
 * collections, so we steer them to the clothed People & Poses category
 * instead of refusing.
 */
const REDIRECT_TO_PEOPLE = ["figure drawing", "life drawing", "figure model", "life model", "figure study", "croquis"];

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[013457@$!]/g, (c) => LEET[c] ?? c)
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "nuuuude" -> "nude". */
function squeeze(word: string): string {
  return word.replace(/(.)\1+/g, "$1");
}

/** Joins runs of single letters: "n u d e" -> "nude". */
function joinSpelledOut(tokens: string[]): string[] {
  const out: string[] = [];
  let run = "";
  for (const t of tokens) {
    if (t.length === 1) {
      run += t;
      continue;
    }
    if (run) out.push(run);
    run = "";
    out.push(t);
  }
  if (run) out.push(run);
  return out;
}

const SINGLE = new Set<string>();
const METADATA_SINGLE = new Set(METADATA_ONLY_WORDS);
/** Squeezed spellings, so stretched words still match. Short ones are skipped to avoid collisions ("xxx" -> "x"). */
const SQUEEZED = new Map<string, string>();
const SQUEEZE_COLLISIONS = new Set(["wed"]); // "weed" squeezes to a real word
const PHRASES: string[][] = [];
for (const w of BLOCKED_WORDS) {
  const parts = w.split(" ");
  if (parts.length > 1) {
    PHRASES.push(parts);
    continue;
  }
  SINGLE.add(w);
  const sq = squeeze(w);
  if (sq !== w && sq.length >= 3 && !SQUEEZE_COLLISIONS.has(sq)) SQUEEZED.set(sq, w);
}

function tokens(text: string): string[] {
  const n = normalize(text);
  return n ? joinSpelledOut(n.split(" ")) : [];
}

function matchWord(t: string): string | null {
  if (SINGLE.has(t)) return t;
  if (t.length > 3 && t.endsWith("s") && SINGLE.has(t.slice(0, -1))) return t.slice(0, -1);
  const sq = squeeze(t);
  if (SINGLE.has(sq)) return sq;
  return SQUEEZED.get(sq) ?? null;
}

function containsPhrase(toks: string[], phrase: string[]): boolean {
  outer: for (let i = 0; i + phrase.length <= toks.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (toks[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Returns the first blocked term found, or null if the text is fine.
 * `metadata: true` adds words that are fine to type but a bad sign in an image's title or tags.
 */
export function findBlockedTerm(text: string, opts: { metadata?: boolean } = {}): string | null {
  const toks = tokens(text);
  for (const t of toks) {
    const hit = matchWord(t);
    if (hit) return hit;
    if (opts.metadata && (METADATA_SINGLE.has(t) || (t.endsWith("s") && METADATA_SINGLE.has(t.slice(0, -1))))) return t;
  }
  for (const p of PHRASES) if (containsPhrase(toks, p)) return p.join(" ");
  return null;
}

export type PromptCheck =
  | { ok: true; redirectToPeople: boolean }
  | { ok: false; term: string };

export function checkPrompt(prompt: string): PromptCheck {
  const term = findBlockedTerm(prompt);
  if (term) return { ok: false, term };
  const n = normalize(prompt);
  return { ok: true, redirectToPeople: REDIRECT_TO_PEOPLE.some((r) => n.includes(r)) };
}

export const FRIENDLY_REFUSAL = "Let's draw something else! Try animals, castles, hands or rockets.";
