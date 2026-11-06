/** Offset -> 1-based line lookup over a precomputed line-start table (binary search). */
export class LineTable {
  private readonly starts: number[];

  constructor(text: string) {
    const starts = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    this.starts = starts;
  }

  /** 1-based line of `offset` (offsets past the end land on the last line). */
  lineOf(offset: number): number {
    const s = this.starts;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((s[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}
