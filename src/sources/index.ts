import type { SourceId } from "../types";
import { commons } from "./commons";
import { nasa } from "./nasa";
import { openverse } from "./openverse";
import type { ImageSource } from "./types";

export const SOURCES: Record<SourceId, ImageSource> = { openverse, commons, nasa };
