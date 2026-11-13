import type { SourceId } from "../types";

export interface Category {
  id: string;
  label: string;
  icon: string;
  /** A session for this category mixes a few random subjects from this pool. */
  subjects: string[];
  sources: SourceId[];
  /**
   * Stricter image thresholds. Used where people are the subject.
   * People categories also skip Wikimedia Commons, which has no safe-search.
   */
  strict?: boolean;
}

export const CATEGORIES: Category[] = [
  {
    id: "people",
    label: "People & Poses",
    icon: "🧍",
    strict: true,
    sources: ["openverse"],
    subjects: [
      "person walking", "person running", "person sitting", "dancer", "skateboarder",
      "basketball player", "soccer player", "martial arts", "person stretching",
      "person reading", "musician playing guitar", "rock climber",
    ],
  },
  {
    id: "faces",
    label: "Faces & Expressions",
    icon: "🙂",
    strict: true,
    sources: ["openverse"],
    subjects: [
      "smiling portrait", "face profile", "laughing person", "surprised face",
      "elderly man portrait", "grandmother portrait", "thoughtful portrait", "man with beard",
    ],
  },
  {
    id: "hands",
    label: "Hands & Feet",
    icon: "✋",
    strict: true,
    sources: ["commons", "openverse"],
    subjects: [
      "hands", "hand holding cup", "hand pointing", "hands clasped", "hand gesture",
      "hands knitting", "sneakers", "boots",
    ],
  },
  {
    id: "animals",
    label: "Animals",
    icon: "🐴",
    sources: ["commons", "openverse"],
    subjects: [
      "cat", "dog", "horse", "owl", "fox", "elephant", "giraffe", "rabbit", "parrot",
      "frog", "turtle", "lion", "deer", "penguin", "squirrel", "cow",
    ],
  },
  {
    id: "structure",
    label: "Animal Structure",
    icon: "🦴",
    sources: ["commons", "openverse"],
    subjects: [
      "animal skeleton museum", "bird skeleton", "dinosaur skeleton", "horse skeleton",
      "butterfly specimen", "seashell", "animal skull museum",
    ],
  },
  {
    id: "plants",
    label: "Plants & Flowers",
    icon: "🌻",
    sources: ["commons", "openverse"],
    subjects: [
      "sunflower", "rose", "oak tree", "succulent", "mushroom", "fern", "leaf closeup",
      "cactus", "tulip", "pine cone",
    ],
  },
  {
    id: "landscapes",
    label: "Landscapes & Nature",
    icon: "🏔️",
    sources: ["commons", "openverse"],
    subjects: [
      "mountains", "forest path", "waterfall", "desert dunes", "clouds", "river valley",
      "snowy mountains", "lake reflection", "canyon", "rocky coast",
    ],
  },
  {
    id: "architecture",
    label: "Architecture & Places",
    icon: "🏰",
    sources: ["commons", "openverse"],
    subjects: [
      "castle", "old house", "lighthouse", "city street", "stone bridge", "cathedral",
      "red barn", "cottage", "skyscraper", "windmill",
    ],
  },
  {
    id: "vehicles",
    label: "Vehicles & Machines",
    icon: "🚂",
    sources: ["commons", "openverse", "nasa"],
    subjects: [
      "vintage car", "steam locomotive", "airplane", "sailboat", "bicycle", "tractor",
      "motorcycle", "fire truck", "helicopter", "excavator",
    ],
  },
  {
    id: "space",
    label: "Space & Flight",
    icon: "🚀",
    sources: ["nasa", "commons"],
    subjects: [
      "astronaut", "rocket launch", "space shuttle", "moon surface", "mars rover",
      "space station", "jet aircraft", "saturn",
    ],
  },
  {
    id: "objects",
    label: "Objects & Still Life",
    icon: "🍎",
    sources: ["commons", "openverse"],
    subjects: [
      "fruit bowl", "teapot", "coffee mug", "apple", "toy robot", "teddy bear",
      "backpack", "vase", "old lamp", "pumpkin",
    ],
  },
  {
    id: "fabric",
    label: "Clothing & Fabric",
    icon: "🧣",
    sources: ["commons", "openverse"],
    subjects: [
      "fabric folds", "drapery", "coat on hook", "medieval armor", "folded blanket",
      "curtains", "hats", "knitted sweater",
    ],
  },
  {
    id: "textures",
    label: "Textures & Materials",
    icon: "🪵",
    sources: ["commons", "openverse"],
    subjects: [
      "tree bark", "stone wall", "rusty metal", "wood grain", "water ripples",
      "fur closeup", "snake scales", "moss",
    ],
  },
  {
    id: "light",
    label: "Light & Shadow",
    icon: "💡",
    sources: ["commons", "openverse"],
    subjects: [
      "sunset silhouette", "candle light", "window light", "long shadows", "backlit tree",
      "street lights night", "light through trees",
    ],
  },
  {
    id: "creatures",
    label: "Creature Inspiration",
    icon: "🐉",
    sources: ["commons", "openverse"],
    subjects: [
      "lizard closeup", "beetle macro", "bat wings", "coral reef", "chameleon",
      "dragonfly", "octopus", "ram horns", "crab", "moth macro",
    ],
  },
];

export function categoryById(id: string | undefined): Category | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

/** Matches a typed prompt like "animals" or "Hands & Feet" to a category. */
export function categoryForPrompt(prompt: string): Category | undefined {
  const p = prompt.trim().toLowerCase();
  return CATEGORIES.find(
    (c) => c.id === p || c.label.toLowerCase() === p || c.label.toLowerCase().split(" & ").includes(p),
  );
}
