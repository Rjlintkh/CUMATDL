/* eslint-disable no-console */
import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs';
import https from 'https';
import logUpdate from 'log-update';
import path from 'path';
import puppeteer, { Page } from 'puppeteer';
import readline from 'readline';

const PMA_CBROOT = 'https://www.math.cuhk.edu.hk/course_builder/';
const PMA_IP = '137.189.49.33';
const PMA_NAME = 'www.math.cuhk.edu.hk';

const ALLOWED_HOSTS = new Set([PMA_NAME, PMA_IP]);
const DOWNLOAD_ROOT = path.resolve('./dl/');

const COURSE_PATTERN = /^[A-Za-z]{4}\d{4}.*$/;
const YEAR_PATTERN = /^_?\d{4}$/;
const YEAR_FIX_REGEX_SOURCE = '(\\/course_builder\\/)(?:_?\\d{4})(\\/)';
const STAFF_PREFIX = 'https://www.math.cuhk.edu.hk/~';

const CURRENT_YEAR = '2526';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

interface YearChoice {
  label: string;
  displayLabel: string;
  href: string;
  seg: string;
}

interface CourseChoice {
  label: string;
  displayLabel: string;
  href: string;
}

interface CourseProgressPayload {
  courseName: string;
  downloaded: number;
  total: number;
}

interface InjectionConfig {
  applyYearRewrite: boolean;
  yearExpSource: string;
  yearPrefix: string;
  courseYearDigits: string;
  staffPrefix: string;
  forceHostReplacement: boolean;
  hostNeedingFix: string;
  hostReplacement: string;
  missingLogger?: (msg: string) => void;
  courseProgressCb?: (payload: CourseProgressPayload | null) => void;
}

/* ---------- persistent progress bar ---------- */
let currentProgressLine = '';

const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);

console.log = (...args: unknown[]): void => {
  if (currentProgressLine) logUpdate.clear();
  originalLog(...args);
  if (currentProgressLine) logUpdate(currentProgressLine);
};

console.error = (...args: unknown[]): void => {
  if (currentProgressLine) logUpdate.clear();
  originalError(...args);
  if (currentProgressLine) logUpdate(currentProgressLine);
};

function setProgressLine(text: string): void {
  currentProgressLine = text;
  if (currentProgressLine) {
    logUpdate(currentProgressLine);
  } else {
    logUpdate.clear();
  }
}

function clearProgressLine(): void {
  currentProgressLine = '';
  logUpdate.clear();
  logUpdate.done();
}

/* ---------- helper functions ---------- */

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer);
  }));
}

function listChoices<T extends { displayLabel: string; href: string }>(items: T[]): void {
  const width = String(items.length).length;
  items.forEach((item, idx) => {
    const indexLabel = `[${chalk.gray(String(idx + 1).padStart(width, ' '))}]`;
    console.log(`${indexLabel} ${chalk.cyanBright(item.displayLabel)} (${item.href})`);
  });
}

async function chooseYear(yearChoices: YearChoice[]): Promise<YearChoice> {
  console.log(chalk.bold('\nSelect an academic year:'));
  listChoices(yearChoices);
  while (true) {
    const rangeLabel = chalk.gray(`1-${yearChoices.length}`);
    const ans = await prompt(chalk.yellow(`Enter a number [${rangeLabel}]: `));
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= yearChoices.length) return yearChoices[n - 1];
    console.log('Invalid choice. Try again.');
  }
}

function parseCourseSelection(input: string, max: number): number[] {
  const selections = new Set<number>();
  const chunks = input.split(',').map(s => s.trim()).filter(Boolean);
  if (!chunks.length) throw new Error('No valid selections provided.');

  for (const chunk of chunks) {
    const range = chunk.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let start = Number(range[1]);
      let end = Number(range[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error(`Invalid range "${chunk}".`);
      }
      if (start > end) [start, end] = [end, start];
      if (start < 1 || end > max) {
        throw new Error(`Range "${chunk}" is out of bounds (1-${max}).`);
      }
      for (let i = start; i <= end; i++) selections.add(i - 1);
      continue;
    }

    const num = Number(chunk);
    if (!Number.isInteger(num) || num < 1 || num > max) {
      throw new Error(`Invalid selection "${chunk}" (must be within 1-${max}).`);
    }
    selections.add(num - 1);
  }

  return Array.from(selections).sort((a, b) => a - b);
}

async function chooseCourses(courseChoices: CourseChoice[]): Promise<{ courses: CourseChoice[]; allSelected: boolean }> {
  console.log(chalk.bold(`\nSelect course(s):`));
  listChoices(courseChoices);
  while (true) {
    const rangeLabel = chalk.gray(`1-${courseChoices.length}`);
    const ans = await prompt(
      chalk.yellow(`Enter a number/list [${rangeLabel}], ranges, or ${chalk.gray("-1")} for all: `)
    );
    const trimmed = ans.trim();
    if (trimmed === '-1') {
      console.log(chalk.greenBright('> Downloading ALL courses in this year.\n'));
      return { courses: courseChoices, allSelected: true };
    }
    try {
      const indices = parseCourseSelection(trimmed, courseChoices.length);
      return { courses: indices.map(i => courseChoices[i]), allSelected: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(message));
    }
  }
}

const segmentFromHref = (href: string): string =>
  href.replace(/\/+$/, '').split('/').pop() ?? '';
const normalizeYear = (seg: string): string => (seg.startsWith('_') ? seg : `_${seg}`);
const yearDigits = (yearName: string): string => yearName.replace(/^_/, '');

function localPathFromUrl(url: string): string {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'course_builder') parts.shift();
  const decoded = parts.map(seg => decodeURIComponent(seg));
  return path.join(DOWNLOAD_ROOT, ...decoded);
}

async function downloadFile(url: string): Promise<void> {
  const localPath = localPathFromUrl(url);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  if (fs.existsSync(localPath)) {
    console.log(`[${chalk.cyanBright('CUMATDL')}] ${chalk.gray("SKIP")} existing file: ${localPath}`);
    return;
  }
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    httpsAgent,
    timeout: 120_000
  });
  await fs.promises.writeFile(localPath, response.data);
  console.log(`[${chalk.cyanBright('CUMATDL')}] ${chalk.greenBright("DONE")} ${localPath}`);
}

function renderProgress(
  completed: number,
  total: number,
  courseProgress?: CourseProgressPayload | null
): void {
  if (total <= 0) {
    clearProgressLine();
    return;
  }
  const barLen = 24;
  const filled = Math.round((completed / total) * barLen);
  const bar = `${'█'.repeat(filled)}${'-'.repeat(barLen - filled)}`;
  const percent = ((completed / total) * 100).toFixed(1);
  const lines = [chalk.yellow(`[Overall%] [${bar}] ${completed}/${total} (${percent}%)`)];
  if (courseProgress && courseProgress.total > 0) {
    const coursePercent = ((courseProgress.downloaded / courseProgress.total) * 100).toFixed(1);
    lines.push(
      chalk.yellow(
        `[Course %] ${courseProgress.courseName}: ${courseProgress.downloaded}/${courseProgress.total} (${coursePercent}%)`
      )
    );
  }
  setProgressLine(lines.join('\n'));
}

/* ---------- per course ---------- */

async function processCourse(page: Page, courseChoice: CourseChoice, config: InjectionConfig): Promise<void> {
  console.log(chalk.bold(`\nNavigating to course: ${courseChoice.label}`));
  await page.goto(courseChoice.href, { waitUntil: ['domcontentloaded', 'networkidle0'] });
  console.log(
    `[${chalk.cyanBright('CUMATDL')}] Year rewrite: ${config.applyYearRewrite ? 'enabled' : 'disabled'}; host fix: ${
    config.forceHostReplacement ? 'enabled' : 'disabled'
    }`
  );

  const evaluateWithRetry = async <T>(
    fn: (cfg: InjectionConfig) => T | Promise<T>,
    arg: InjectionConfig,
    retries = 3
  ): Promise<T> => {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await page.evaluate(fn, arg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const destroyed = /Execution context was destroyed|Cannot find context with specified id/i.test(message);
        if (!destroyed || attempt === retries - 1) throw err;
        console.log("[Injector] Page refreshed itself; retrying evaluation...");
        await new Promise(resolve => setTimeout(resolve, 1000));
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10_000 }).catch(() => {});
      }
    }
    throw new Error('Evaluation retries exceeded');
  };

  const { downloadUrls = [], serializedHtml = '' } = await evaluateWithRetry(
    (cfg: InjectionConfig) => {
      const yearExp = cfg.applyYearRewrite ? new RegExp(cfg.yearExpSource, 'i') : null;
      const urls: string[] = [];

      const baseDir = location.pathname.endsWith('/') ? location.pathname : location.pathname.replace(/[^/]+$/, '/');

      const splitSegments = (pathname: string): string[] =>
        pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
      const baseParts = splitSegments(baseDir);

      const toRelative = (targetPath: string): string => {
        const targetParts = splitSegments(targetPath);
        let i = 0;
        while (i < baseParts.length && i < targetParts.length && baseParts[i] === targetParts[i]) i++;
        const up = baseParts.slice(i).map(() => '..');
        const down = targetParts.slice(i);
        const rel = [...up, ...down].join('/');
        return rel || '.';
      };

      const normalizeUrl = (href: string): URL | null => {
        let target: URL;
        try {
          target = new URL(href, location.href);
        } catch {
          return null;
        }

        if (cfg.forceHostReplacement && target.hostname === cfg.hostNeedingFix) {
          target.hostname = cfg.hostReplacement;
          target.port = '';
        }

        if (yearExp) {
          const newPath = target.pathname.replace(
            yearExp,
            (_match, p1: string, p2: string) => `${p1}${cfg.yearPrefix}${cfg.courseYearDigits}${p2}`
          );
          target.pathname = newPath;
        }

        return target;
      };

      document.querySelectorAll('li').forEach(li => {
        const a = li.querySelector('a');
        if (!a) return;
        if (a.href.includes('javascript:')) {
          console.log(`[Injector] SKIP JS Link: ${a.href}`);
          return;
        }
        const fixed = normalizeUrl(a.href);
        if (!fixed) return;
        const finalHref = fixed.toString();
        urls.push(finalHref);
        console.log(`[Injector] URL added: ${finalHref}`);
      });

      document.querySelectorAll('a[href]').forEach(a => {
        const rawHref = a.getAttribute('href');
        if (!rawHref || rawHref.startsWith('javascript:')) return;

        const fixed = normalizeUrl(rawHref);
        if (!fixed) return;

        if (fixed.href.startsWith(cfg.staffPrefix)) return;

        if (fixed.origin === location.origin && fixed.pathname.startsWith('/course_builder/')) {
          const relPath = toRelative(fixed.pathname);
          const newHref = relPath + fixed.search + fixed.hash;
          a.setAttribute('href', newHref);
        } else {
          a.setAttribute('href', fixed.toString());
        }
      });

      const docHtml = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      return { downloadUrls: urls, serializedHtml: docHtml };
    },
    config
  );

  const usableUrls = downloadUrls.filter(url => {
    if (url.startsWith(STAFF_PREFIX)) return false;
    try {
      const u = new URL(url);
      if (!ALLOWED_HOSTS.has(u.hostname)) return false;
      if (!u.pathname.startsWith('/course_builder/')) return false;
      return true;
    } catch {
      return false;
    }
  });

  const skipped = downloadUrls.length - usableUrls.length;
  if (skipped) {
    console.log(`[${chalk.cyanBright('CUMATDL')}] Skipped ${skipped} link(s) (staff-only or external).`);
  }

  if (serializedHtml) {
    const htmlDir = localPathFromUrl(courseChoice.href);
    const htmlPath = path.join(htmlDir, 'index.html');
    await fs.promises.mkdir(path.dirname(htmlPath), { recursive: true });
    await fs.promises.writeFile(htmlPath, serializedHtml, 'utf8');
    console.log(`[${chalk.cyanBright('CUMATDL')}] ${chalk.greenBright("DONE")} modified index ${htmlPath}`);
  } else {
    console.log(`[${chalk.cyanBright('CUMATDL')}] ${chalk.red("Warning: index.html not captured.")}`);
  }

  if (!usableUrls.length) {
    console.log(`[${chalk.cyanBright('CUMATDL')}] ${chalk.yellow("No downloadable URLs detected for this course.")}`);
    config.missingLogger?.(`[${courseChoice.label}] No downloadable URLs detected`);
    return;
  }

  config.courseProgressCb?.({ courseName: courseChoice.label, downloaded: 0, total: usableUrls.length });
  console.log(`[${chalk.cyanBright('CUMATDL')}] Downloading ${usableUrls.length} file(s) for ${courseChoice.label}...`);

  for (let i = 0; i < usableUrls.length; i++) {
    const url = usableUrls[i];
    const decoded = decodeURI(url);
    try {
      await downloadFile(decoded);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const entry = `[${courseChoice.label}] ${decoded} :: ${message}`;
      console.error(`[${chalk.cyanBright('CUMATDL')}] ${chalk.red("FAIL")} ${decoded}: ${message}`);
      config.missingLogger?.(entry);
    } finally {
      config.courseProgressCb?.({
        courseName: courseChoice.label,
        downloaded: i + 1,
        total: usableUrls.length
      });
    }
  }

  config.courseProgressCb?.(null); // clear per-course progress line
}

/* ---------- main ---------- */

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--ignore-certificate-errors']
  });
  const page = await browser.newPage();

  await page.goto(PMA_CBROOT, { waitUntil: ['domcontentloaded', 'networkidle0'] });

  const yearDirs = await page.$$eval(
    'body > table > tbody > tr > td:nth-child(2) > a',
    anchors =>
      anchors
        .map(a => ({
          text: a.textContent?.trim() ?? '',
          href: a.href,
          raw: a.getAttribute('href') ?? ''
        }))
        .filter(item => item.href.endsWith('/'))
  );

  let yearChoices: YearChoice[] = yearDirs
    .map(item => {
      const seg =
        item.text?.replace(/\/+$/, '') ||
        item.raw.replace(/\/+$/, '').split('/').pop() ||
        '';
      const labelWithoutUnderscore = seg.replace(/^_/, '');
      return {
        label: seg,
        displayLabel: labelWithoutUnderscore,
        href: item.href,
        seg
      };
    })
    .filter(item => YEAR_PATTERN.test(item.seg));

  const currentIdx = yearChoices.findIndex(y => y.displayLabel === CURRENT_YEAR);
  if (currentIdx >= 0) {
    const [currentItem] = yearChoices.splice(currentIdx, 1);
    yearChoices.push(currentItem);
  }

  if (!yearChoices.length) {
    console.error(chalk.red('No year folders found.'));
    await browser.close();
    clearProgressLine();
    return;
  }

  const yearChoice = await chooseYear(yearChoices);
  const normalizedYear = normalizeYear(yearChoice.seg);
  const hasUnderscore = yearChoice.seg.startsWith('_');
  const skipYearRewrite = yearChoice.displayLabel === CURRENT_YEAR && !hasUnderscore;
  const forceHostReplacement = yearChoice.displayLabel === CURRENT_YEAR && !hasUnderscore;

  console.log(chalk.bold(`\nOpening folder: ${normalizedYear}`));
  await page.goto(yearChoice.href, { waitUntil: ['domcontentloaded', 'networkidle0'] });

  const courseDirs = await page.$$eval(
    'body > table > tbody > tr > td:nth-child(2) > a',
    anchors =>
      anchors.map(a => ({
        href: a.href,
        raw: a.getAttribute('href') ?? '',
        text: a.textContent?.trim() ?? ''
      }))
  );

  const courseChoices: CourseChoice[] = courseDirs
    .filter(item => item.href.endsWith('/'))
    .map(item => {
      const seg =
        segmentFromHref(item.href) ||
        segmentFromHref(item.raw) ||
        item.text;
      return { label: seg, displayLabel: seg, href: item.href };
    })
    .filter(item => COURSE_PATTERN.test(item.label));

  if (!courseChoices.length) {
    console.error(chalk.red('No matching course folders (must start with 4 letters + 4 digits).'));
    await browser.close();
    clearProgressLine();
    return;
  }

  const { courses: selectedCourses, allSelected } = await chooseCourses(courseChoices);
  const courseYear = yearDigits(normalizedYear);
  const missingLog: string[] | null = allSelected ? [] : null;
  const totalCourses = selectedCourses.length;
  let completedCourses = 0;

  const updateProgress = (courseProgress?: CourseProgressPayload | null): void => {
    renderProgress(completedCourses, totalCourses, courseProgress);
  };

  for (const course of selectedCourses) {
    const injectionConfig: InjectionConfig = {
      applyYearRewrite: !skipYearRewrite,
      yearExpSource: YEAR_FIX_REGEX_SOURCE,
      yearPrefix: hasUnderscore ? '_' : '',
      courseYearDigits: courseYear,
      staffPrefix: STAFF_PREFIX,
      forceHostReplacement,
      hostNeedingFix: PMA_IP,
      hostReplacement: PMA_NAME,
      missingLogger: missingLog ? (msg: string) => missingLog.push(msg) : undefined,
      courseProgressCb: updateProgress
    };
    await processCourse(page, course, injectionConfig);
    completedCourses += 1;
    updateProgress(null); // clear per-course line, show only overall
  }

  if (missingLog && missingLog.length) {
    const missingPath = path.join(DOWNLOAD_ROOT, normalizedYear, 'missing.txt');
    await fs.promises.mkdir(path.dirname(missingPath), { recursive: true });
    await fs.promises.writeFile(missingPath, `${missingLog.join('\n')}\n`, 'utf8');
    console.log(`[${chalk.cyanBright('CUMATDL')}] Report log saved to: ${missingPath}`);
  }

  console.log(chalk.bold('\nAll done.'));
  await browser.close();
  clearProgressLine();
})().catch(err => {
  clearProgressLine();
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(chalk.red(message));
  process.exit(1);
});