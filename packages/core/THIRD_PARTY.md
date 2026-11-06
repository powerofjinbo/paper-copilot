# Third-party material in @paper-copilot/core

## Excess vocabulary of LLM-assisted writing (Kobak et al. 2025)

- **What:** `src/meta/data/excessVocab.ts` (`KOBAK_2024_STYLE`, `KOBAK_UNMEASURED_INFLECTIONS`), used by
  `src/meta/aiese.ts` (`EXCESS_VOCAB`, `aieseFlags`) and the style meter (`excessVocabRate`).
- **Source:** D. Kobak, R. González-Márquez, E.-Á. Horvát, J. Lause, "Delving into LLM-assisted writing in
  biomedical publications through excess vocabulary", *Science Advances* 11, eadt3813 (2025),
  doi:10.1126/sciadv.adt3813, arXiv:2406.07016. Data and code: https://github.com/berenslab/llm-excess-vocab,
  commit `53db991afc251782106cd817a1c3fa47a4d41781` (2026-05-22).
- **Licence:** MIT (text below). The repository's LICENSE covers the software and its associated files,
  including `results/excess_words.csv` and `results/yearly-counts.csv.gz`, so the derived word list may be
  redistributed with this notice.
- **What was taken and how:** the 379 words that the paper identifies as 2024 excess words and that its
  authors annotate as `style` in `results/excess_words.csv`. For each word the excess frequency ratio *r* and
  gap *δ* are recomputed exactly as the paper's notebook (`scripts/03-figures.ipynb`, `compute_excess(2024)`)
  computes them from `results/yearly-counts.csv.gz`:
  `p = (count + 1) / (abstracts + 1)`, `q = p₂₀₂₂ + 2·max(p₂₀₂₂ − p₂₀₂₁, 0)`, `r = p₂₀₂₄ / q`, `δ = p₂₀₂₄ − q`.
  The recomputation reproduces every value the notebook prints (delves 28.0, underscores 13.8,
  showcasing 10.7, crucial 2.1, potential 1.3, findings 1.3). No ratio is typed by hand; a form the paper
  could not measure (below its 10⁻⁴ frequency cutoff) has ratio `null`.
- **Note on quoted numbers:** values such as "underscores 10.9" or "showcasing 10.2" that circulate for this
  paper do not match its current data release; they were not used. The values here are those the authors'
  notebook prints from the released data.
- **Regenerate or load the full list:** `src/meta/data/regenerate.py` rebuilds both data files:

  ```bash
  git clone --depth 1 https://github.com/berenslab/llm-excess-vocab /tmp/llm-excess-vocab
  python3 -I packages/core/src/meta/data/regenerate.py /tmp/llm-excess-vocab path/to/hep-paper-writing/scripts/style_check.py
  ```

  (needs numpy and pandas). To use other years or all 900 annotated words (content words such as *covid* or
  *chatgpt* included), change the filter on `w2t.get(w) == 'style'` and the target year in
  `compute_excess(2024)` in that script.

### MIT License (llm-excess-vocab)

```
MIT License

Copyright (c) 2024 Dmitry Kobak, Rita González-Márquez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Word lists from the hep-paper-writing skill

- **What:** `src/meta/data/styleCheckLists.ts` (verb bases, function words, the passive detector's lists,
  `CONN_A`/`CONN_B`, `INFLATED`, `HYPE`, number and statistics patterns), used by `src/meta/style.ts`.
- **Source:** the user's own skill, `scripts/style_check.py` of https://github.com/powerofjinbo/hep-writing-skill
  (the file's sha256 is recorded in the generated header). Copied by `regenerate.py`; the skill states no
  licence, and it is used here by its author's project.
- **Not from the skill:** the hedge list (`HEDGE_RE` in `src/meta/style.ts`; the skill reports a hedge rate
  but ships no list), the AI-ese phrase patterns (`AI_PATTERNS`), the style spreads (`STYLE_SPREADS`) and the
  `HEP_NEUTRAL` exclusions are this project's own and are labelled as such in the code.
