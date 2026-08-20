/**
 * Judging a fetched page without a browser.
 *
 * These two decide whether a plain HTTP GET was enough or the scrape has to escalate to
 * a paid headless browser. Escalating needlessly costs money; failing to escalate hands
 * the model an empty page and then blames the model for the output — so they live here,
 * pure and tested, rather than inside the fetch that uses them.
 */

/**
 * Below this, the response is markup with no prose — a JavaScript shell whose content
 * has not arrived. Real landers run to well over a thousand words; the threshold only
 * has to separate "a page" from "an empty <div id=root>".
 */
export const MIN_TEXT_WORDS = 120;

/**
 * Strings no page emits by accident. A machine token in the markup is proof on its own.
 */
const HARD_MARKERS = /cf-browser-verification|cf_chl_opt|__cf_chl|cf-please-wait|_Incapsula_/i;

/**
 * Phrases a challenge page uses — and so, occasionally, does ordinary copy. "Give us
 * just a moment of your time" is a perfectly normal advertorial sentence, and treating
 * it as a bot wall would escalate a working fetch to a paid browser for nothing. They
 * only count on a page with no prose around them, which is what a challenge is.
 */
const SOFT_MARKERS = /just a moment|checking your browser|enable javascript and cookies/i;

export function looksLikeChallenge(html: string): boolean {
  if (HARD_MARKERS.test(html)) return true;
  return SOFT_MARKERS.test(html) && visibleWordCount(html) < MIN_TEXT_WORDS;
}

/** Words outside script and style. Cheap, and only has to spot an empty shell. */
export function visibleWordCount(html: string): number {
  const text = html
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");
  const words = text.trim().split(/\s+/);
  return words[0] === "" ? 0 : words.length;
}
