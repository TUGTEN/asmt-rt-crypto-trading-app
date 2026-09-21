import { splitFigure } from "@/lib/format";

/**
 * One table figure: the significant head (whole part plus two decimals) at full
 * strength, the tail past it dimmed — the annotator's reference price column,
 * `0.102196` reads as `0.10` first and `2196` second. Figures with no tail
 * (prices at two decimals, the `—` placeholder) render as a single run.
 *
 * Presentational: a formatted string in, two spans out. Tabular figures come
 * from the parent table's `font-mono tabular-nums`, so every row holds its
 * width whether the tail is there or not.
 */
export function Figure({ value }: { value: string }) {
  const { head, tail } = splitFigure(value);
  return (
    <span className="tabular-nums">
      {head}
      {tail === "" ? null : (
        // Tails recede from heads in BOTH modes without a new token (multiplying faint over either surface lightens/darkens it toward the background).
        <span className="text-faint opacity-70">{tail}</span>
      )}
    </span>
  );
}
