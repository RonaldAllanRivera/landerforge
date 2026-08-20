import type { TemplateManifest } from "./manifest";
import {
  generatedFields,
  instanceCount,
  readField,
  renderFieldValue,
  type SectionOutput,
} from "./section-io";

/**
 * Comparing two versions of a page, field by field.
 *
 * A version history that only lists runs answers "when" and never "what changed", which
 * is the question somebody actually has when deciding whether a regenerate was an
 * improvement. Word-level rather than character-level: this is prose, and a character
 * diff of a rewritten sentence is confetti.
 */

export type TokenKind = "same" | "added" | "removed";
export interface Token {
  kind: TokenKind;
  text: string;
}

/**
 * Above this many words on either side, the quadratic diff is skipped.
 *
 * A longest-common-subsequence table is words-before × words-after cells. The
 * Advertorial body runs to about 1,000 words, so two of them is a million — fine. A
 * pathological pair is not, and a review screen that hangs is worse than one that says
 * "this changed" without underlining which words.
 */
export const INLINE_DIFF_WORD_CAP = 2500;

/**
 * Below this much shared text, inline marks stop helping.
 *
 * Two versions of one sentence want the changed words underlined. Two entirely
 * different pages want to be read side by side — interleaving them produces a page of
 * alternating strikethrough and underline where every other word has moved, which is
 * technically a correct diff and impossible to read. Measured on two versions written
 * from different source URLs, which is exactly the case that looks like a bug.
 */
export const MIN_INLINE_SIMILARITY = 0.3;

function wholeBlock(before: string, after: string): Token[] {
  return [
    ...(before ? [{ kind: "removed" as const, text: before }] : []),
    ...(after ? [{ kind: "added" as const, text: after }] : []),
  ];
}

export function diffWords(before: string, after: string): Token[] {
  if (before === after) return before ? [{ kind: "same", text: before }] : [];

  const a = splitWords(before);
  const b = splitWords(after);
  if (a.length > INLINE_DIFF_WORD_CAP || b.length > INLINE_DIFF_WORD_CAP) {
    return wholeBlock(before, after);
  }

  // Standard LCS table, walked back to a token list.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      const next = lcs[i + 1] as number[];
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const tokens: Token[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(tokens, "same", a[i] as string);
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      push(tokens, "removed", a[i] as string);
      i++;
    } else {
      push(tokens, "added", b[j] as string);
      j++;
    }
  }
  while (i < a.length) push(tokens, "removed", a[i++] as string);
  while (j < b.length) push(tokens, "added", b[j++] as string);

  if (similarity(tokens, before, after) < MIN_INLINE_SIMILARITY) {
    return wholeBlock(before, after);
  }
  return tokens;
}

/** Share of the longer side that survived unchanged. */
function similarity(tokens: readonly Token[], before: string, after: string): number {
  const longest = Math.max(before.length, after.length);
  if (longest === 0) return 1;
  const kept = tokens
    .filter((t) => t.kind === "same")
    .reduce((total, t) => total + t.text.trim().length, 0);
  return kept / longest;
}

/** Runs of the same kind are merged, so the rendered output is spans not confetti. */
function push(tokens: Token[], kind: TokenKind, text: string) {
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) last.text += text;
  else tokens.push({ kind, text });
}

/** Keeps whitespace attached so joining the tokens reproduces the original exactly. */
function splitWords(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

export type ChangeKind = "same" | "changed" | "added" | "removed";

export interface FieldDiff {
  key: string;
  label: string;
  /** "Review 2" for a repeating section, absent otherwise. */
  instance?: string;
  kind: ChangeKind;
  before: string;
  after: string;
  tokens: Token[];
}

export interface SectionDiff {
  sectionId: string;
  label: string;
  fields: FieldDiff[];
  changed: number;
}

export interface GenerationDiff {
  sections: SectionDiff[];
  changed: number;
  unchanged: number;
}

/**
 * Diff two runs of the same template.
 *
 * Driven by the manifest rather than by the stored keys, so a field the older run never
 * produced still appears — "this version added a sidebar CTA" is a change worth seeing,
 * and iterating the outputs alone would hide it.
 */
export function diffGenerations(
  manifest: TemplateManifest,
  before: Record<string, SectionOutput | null>,
  after: Record<string, SectionOutput | null>,
): GenerationDiff {
  const sections: SectionDiff[] = [];
  let changed = 0;
  let unchanged = 0;

  for (const section of manifest.sections) {
    const fields = generatedFields(section);
    if (fields.length === 0) continue;

    const beforeOutput = before[section.id] ?? null;
    const afterOutput = after[section.id] ?? null;
    const instances = Math.max(
      instanceCount(section, beforeOutput),
      instanceCount(section, afterOutput),
    );

    const diffs: FieldDiff[] = [];
    for (let instance = 0; instance < instances; instance++) {
      for (const field of fields) {
        const beforeText = renderFieldValue(
          field,
          readField(section, beforeOutput, field.key, instance),
        );
        const afterText = renderFieldValue(
          field,
          readField(section, afterOutput, field.key, instance),
        );
        if (beforeText === "" && afterText === "") continue;

        const kind: ChangeKind =
          beforeText === afterText
            ? "same"
            : beforeText === ""
              ? "added"
              : afterText === ""
                ? "removed"
                : "changed";

        if (kind === "same") unchanged++;
        else changed++;

        diffs.push({
          key: field.key,
          label: field.label,
          ...(instances > 1 ? { instance: `${singular(section.label)} ${instance + 1}` } : {}),
          kind,
          before: beforeText,
          after: afterText,
          tokens: kind === "same" ? [] : diffWords(beforeText, afterText),
        });
      }
    }

    if (diffs.length > 0) {
      sections.push({
        sectionId: section.id,
        label: section.label,
        fields: diffs,
        changed: diffs.filter((d) => d.kind !== "same").length,
      });
    }
  }

  return { sections, changed, unchanged };
}

function singular(label: string): string {
  return label.replace(/ies$/, "y").replace(/s$/, "");
}
