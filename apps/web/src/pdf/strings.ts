/** UI strings of the PDF pane (en / 中文); kept here so the pane does not depend on shell-owned i18n keys. */
import { useShell } from '../state/extra';

const en = {
  toolbar: 'PDF controls',
  pages: 'PDF pages. Click a line to jump to its source. Plus and minus zoom, 0 fits the width, N and P change page.',
  page: 'Page',
  pageOf: 'of {n}',
  pageInput: 'Page number',
  zoomIn: 'Zoom in (+)',
  zoomOut: 'Zoom out (−)',
  fitWidth: 'Fit width (0)',
  zoomLevel: 'Zoom {p}%',
  empty: 'Compile to see the PDF',
  emptyHint: 'The PDF appears here after the first successful compile.',
  emptyFailed: 'The errors are listed above the editor. Fix them and compile again.',
  failedTitle: 'Compile failed',
  compileAgain: 'Compile again',
  demoTitle: 'No PDF in the browser demo',
  demoHint: 'The demo has no LaTeX. On your laptop, run `pnpm paper open <project>`: it compiles with latexmk and shows the PDF here.',
  noPdfTitle: 'Compiled, but no PDF was written',
  compile: 'Compile',
  compiling: 'Compiling…',
  loading: 'Loading the PDF…',
  updating: 'Updating…',
  staleCompiling: 'Compiling · showing the last PDF',
  staleFailed: 'Compile failed · showing the last good PDF',
  error: 'Could not load the PDF',
  errorNew: 'Could not load the new PDF: {msg}',
  retry: 'Try again',
  noSource: 'No source line at this point.',
  inverseFailed: 'Inverse search failed: {msg}',
  highlighted: 'Highlighted on {where}',
  pageN: 'page {n}',
};

const zh: typeof en = {
  toolbar: 'PDF 控制',
  pages: 'PDF 页面。点击某一行跳到源码；加号和减号缩放，0 适合宽度，N 和 P 翻页。',
  page: '第',
  pageOf: '页 / 共 {n} 页',
  pageInput: '页码',
  zoomIn: '放大 (+)',
  zoomOut: '缩小 (−)',
  fitWidth: '适合宽度 (0)',
  zoomLevel: '缩放 {p}%',
  empty: '编译后在这里查看 PDF',
  emptyHint: '第一次编译成功后，PDF 会显示在这里。',
  emptyFailed: '错误列在编辑器上方。改正后再编译一次。',
  failedTitle: '编译失败',
  compileAgain: '重新编译',
  demoTitle: '浏览器演示里没有 PDF',
  demoHint: '演示版没有 LaTeX。在你的电脑上运行 `pnpm paper open <项目>`：它会用 latexmk 编译，并在这里显示 PDF。',
  noPdfTitle: '编译完成，但没有生成 PDF',
  compile: '编译',
  compiling: '正在编译…',
  loading: '正在加载 PDF…',
  updating: '正在更新…',
  staleCompiling: '正在编译 · 显示上一版 PDF',
  staleFailed: '编译失败 · 显示上一版成功的 PDF',
  error: '无法加载 PDF',
  errorNew: '无法加载新的 PDF：{msg}',
  retry: '重试',
  noSource: '这里没有对应的源码行。',
  inverseFailed: '反向搜索失败：{msg}',
  highlighted: '已在{where}高亮',
  pageN: '第 {n} 页',
};

export type PdfStringKey = keyof typeof en;

export function pdfString(lang: 'en' | 'zh', key: PdfStringKey, vars?: Record<string, string | number>): string {
  let s = (lang === 'zh' ? zh : en)[key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export function usePdfT(): (key: PdfStringKey, vars?: Record<string, string | number>) => string {
  const lang = useShell((s) => s.lang);
  return (key, vars) => pdfString(lang === 'zh' ? 'zh' : 'en', key, vars);
}
