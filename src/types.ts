/** A reference to an image hosted online. We store references, never the image bytes. */
export interface ImageRef {
  /** Globally unique: `${source}:${sourceId}`. */
  id: string;
  source: SourceId;
  sourceId: string;
  /** Full-size image shown while drawing. */
  url: string;
  /** Small, CORS-enabled image used for the safety check and the summary grid. */
  thumbUrl: string;
  /** The page on the original site, for attribution. */
  landingUrl: string;
  title: string;
  creator: string;
  creatorUrl?: string;
  license: string;
  licenseUrl?: string;
  width?: number;
  height?: number;
  tags: string[];
}

export type SourceId = "openverse" | "commons" | "nasa";

export type Orientation = "any" | "landscape" | "portrait" | "square";

export interface SafetyVerdict {
  safe: boolean;
  /** Class probabilities from the image model, when it ran. */
  scores?: Record<string, number>;
  /** Why it was rejected, for debugging and the local "hidden" list. */
  reason?: string;
  /** Bumped whenever thresholds or the model change, so old verdicts are re-checked. */
  version: number;
  checkedAt: number;
}
