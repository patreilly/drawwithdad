import { describe, expect, it } from "vitest";
import { checkPrompt, findBlockedTerm } from "../src/safety/textFilter";

describe("findBlockedTerm", () => {
  it.each(["nude woman", "N.U.D.E", "n u d e", "nuuuude", "s3xy", "bloody wound", "assault rifle", "skinny dipping", "GUNS"])("blocks %s", (p) => {
    expect(findBlockedTerm(p)).not.toBeNull();
  });

  it.each([
    "horse", "hands holding a cup", "castle", "class photo", "Sussex countryside", "sunset beach", "x-ray of a fish",
    "wedding cake", "glass of water", "dragon", "grassy field", "Scunthorpe", "bass guitar", "therapist", "cockatoo",
  ])("allows %s", (p) => {
    expect(findBlockedTerm(p)).toBeNull();
  });
});

describe("checkPrompt", () => {
  it("redirects figure-drawing terms to the clothed people category", () => {
    expect(checkPrompt("figure drawing poses")).toEqual({ ok: true, redirectToPeople: true });
  });
});
