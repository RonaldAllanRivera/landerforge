import { describe, expect, it } from "vitest";
import { looksLikeChallenge, MIN_TEXT_WORDS, visibleWordCount } from "@/lib/shared/page-text";

/**
 * The decision to escalate to a paid browser rests on these two functions. Escalating
 * when it was not needed costs money; not escalating when it was gives the model an
 * empty page and blames the model for the output.
 */
describe("deciding whether a plain fetch was enough", () => {
  it("does not count script or style content as page text", () => {
    const html = `<html><head><style>${"a{color:red}".repeat(200)}</style>
      <script>${"var x = 1;".repeat(200)}</script></head>
      <body><p>Only these five words count.</p></body></html>`;
    expect(visibleWordCount(html)).toBeLessThan(10);
  });

  it("counts the prose of a real page well above the escalation threshold", () => {
    const paragraph = "<p>My wife and I both grew up with dogs and we loved them dearly.</p>";
    expect(visibleWordCount(paragraph.repeat(20))).toBeGreaterThan(MIN_TEXT_WORDS);
  });

  it("treats an empty single-page-app shell as needing a browser", () => {
    const shell = `<html><body><div id="root"></div><script src="/app.js"></script></body></html>`;
    expect(visibleWordCount(shell)).toBeLessThan(MIN_TEXT_WORDS);
  });

  it("recognises a Cloudflare interstitial", () => {
    expect(looksLikeChallenge("<title>Just a moment...</title>")).toBe(true);
    expect(looksLikeChallenge("<div>Checking your browser before accessing</div>")).toBe(true);
    expect(looksLikeChallenge("<p>Enable JavaScript and cookies to continue</p>")).toBe(true);
  });

  it("recognises a machine marker even on a long page", () => {
    const wall = `<div class="cf-browser-verification"></div><p>${"word ".repeat(500)}</p>`;
    expect(looksLikeChallenge(wall)).toBe(true);
  });

  it("does not mistake ordinary copy for a challenge", () => {
    // A real advertorial can say this, and escalating on it would buy a paid browser
    // for a fetch that already worked.
    const lander = `<p>Give us just a moment of your time to explain.</p>
      <p>${"My wife and I both grew up with dogs and loved them dearly. ".repeat(40)}</p>`;
    expect(looksLikeChallenge(lander)).toBe(false);
  });

  it("is not fooled by entities standing in for words", () => {
    expect(visibleWordCount("<p>&nbsp;&nbsp;&nbsp;</p>")).toBe(0);
  });
});
