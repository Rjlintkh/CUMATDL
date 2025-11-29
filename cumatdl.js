/**
 * CUHK Math course-builder downloader
 *
 * Requirements:
 *   npm i puppeteer axios chalk@4 log-update
 *
 * Highlights:
 * - Year picker shows aligned indices and labels without leading underscores.
 * - CURRENT_YEAR (2526) is always listed last in the picker and has special handling.
 * - Course selection accepts single numbers, comma-separated lists, and ranges (e.g., "3,6,12-19,27").
 * - Option “-1” downloads all courses in the chosen year; progress bar stays at the bottom.
 * - Course folders must start with 4 letters + 4 digits (additional suffix allowed).
 * - Special handling for CURRENT_YEAR: no “_YYYY” rewrite; any links to 137.189.49.33 are rewritten to www.math.cuhk.edu.hk.
 * - Injects JS to collect download URLs, rewrite anchor tags to relative paths, and saves index.html.
 * - Skips staff-only links and external domains; downloads only from /course_builder/.
 * - When downloading all courses, any failures are logged to ./<year>/missing.txt.
 * - TLS verification disabled (Puppeteer + Axios) to avoid certificate issues.
 */

const puppeteer = require('puppeteer');
const readline = require('readline');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const logUpdate = require('log-update');

const URL_ROOT = 'https://www.math.cuhk.edu.hk/course_builder/';
const DOWNLOAD_ROOT = path.resolve('.');
const COURSE_PATTERN = /^[A-Za-z]{4}\d{4}.*$/;
const YEAR_PATTERN = /^_?\d{4}$/;
const YEAR_FIX_REGEX_SOURCE = '(\\/course_builder\\/)(?:_?\\d{4})(\\/)';
const STAFF_PREFIX = 'https://www.math.cuhk.edu.hk/~';
const HOST_NEEDS_FIX = '137.189.49.33';
const HOST_PREFERRED = 'www.math.cuhk.edu.hk';
const ALLOWED_HOSTS = new Set([HOST_PREFERRED, HOST_NEEDS_FIX]);
const CURRENT_YEAR = '2526';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/* ---------- console hooks for persistent progress bar ---------- */
let currentProgressLine = '';

const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);

console.log = (...args) => {
  if (currentProgressLine) logUpdate.clear();
  originalLog(...args);
  if (currentProgressLine) logUpdate(currentProgressLine);
};

console.error = (...args) => {
  if (currentProgressLine) logUpdate.clear();
  originalError(...args);
  if (currentProgressLine) logUpdate(currentProgressLine);
};

function setProgressLine(text) {
  currentProgressLine = text;
  if (currentProgressLine) {
    logUpdate(currentProgressLine);
  } else {
    logUpdate.clear();
  }
}

function clearProgressLine() {
  currentProgressLine = '';
  logUpdate.clear();
  logUpdate.done();
}

/* ---------- helpers ---------- */

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

function listChoices(items) {
  const width = String(items.length).length;
  items.forEach((item, idx) => {
    const indexLabel = `[${String(idx + 1).padStart(width, ' ')}]`;
    console.log(chalk.cyan(`${indexLabel} ${item.displayLabel.padEnd(8)} (${item.href})`));
  });
}

async function chooseYear(yearChoices) {
  console.log(chalk.bold('\nSelect a year folder:'));
  listChoices(yearChoices);
  while (true) {
    const ans = await prompt(chalk.yellow(`Enter a number (1-${yearChoices.length}): `));
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= yearChoices.length) return yearChoices[n - 1];
    console.log(chalk.red('Invalid choice. Try again.'));
  }
}

function parseCourseSelection(input, max) {
  const selections = new Set();
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

async function chooseCourses(courseChoices) {
  console.log(chalk.bold('\nSelect a course folder (or -1 for ALL):'));
  listChoices(courseChoices);
  while (true) {
    const ans = await prompt(chalk.yellow(`Enter a number/list (1-${courseChoices.length}), ranges, or -1 for all: `));
    const trimmed = ans.trim();
    if (trimmed === '-1') {
      console.log(chalk.green('> Downloading ALL courses in this year.\n'));
      return { courses: courseChoices, allSelected: true };
    }
    try {
      const indices = parseCourseSelection(trimmed, courseChoices.length);
      return { courses: indices.map(i => courseChoices[i]), allSelected: false };
    } catch (err) {
      console.log(chalk.red(err.message));
    }
  }
}

const segmentFromHref = href => href.replace(/\/+$/, '').split('/').pop();
const normalizeYear = seg => (seg.startsWith('_') ? seg : `_${seg}`);
const yearDigits = yearName => yearName.replace(/^_/, '');

function localPathFromUrl(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'course_builder') parts.shift();
  const decoded = parts.map(seg => decodeURIComponent(seg));
  return path.join(DOWNLOAD_ROOT, ...decoded);
}

async function downloadFile(url) {
  const localPath = localPathFromUrl(url);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  if (fs.existsSync(localPath)) {
    console.log(chalk.gray(`[CUMATDL] Skipping existing file: ${localPath}`));
    return;
  }
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    httpsAgent,
    timeout: 120_000
  });
  await fs.promises.writeFile(localPath, response.data);
  console.log(chalk.green(`[CUMATDL] Downloaded: ${localPath}`));
}

/* Progress bar helper */
function renderProgress(completed, total) {
  if (total <= 0) {
    clearProgressLine();
    return;
  }
  const barLen = 24;
  const filled = Math.round((completed / total) * barLen);
  const bar = `${'█'.repeat(filled)}${'-'.repeat(barLen - filled)}`;
  const percent = ((completed / total) * 100).toFixed(1);
  setProgressLine(chalk.magenta(`[Progress] [${bar}] ${completed}/${total} (${percent}%)`));
}

/* ---------- per course ---------- */

async function processCourse(page, courseChoice, config) {
  console.log(chalk.bold(`\nOpening course folder: ${courseChoice.label}`));
  await page.goto(courseChoice.href, { waitUntil: ['domcontentloaded', 'networkidle0'] });
  console.log(chalk.blue(`[CUMATDL] Year rewrite: ${config.applyYearRewrite ? 'enabled' : 'disabled'}; host fix: ${config.forceHostReplacement ? 'enabled' : 'disabled'}`));

  const evaluateWithRetry = async (fn, arg, retries = 3) => {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await page.evaluate(fn, arg);
      } catch (err) {
        const destroyed = /Execution context was destroyed|Cannot find context with specified id/i.test(err.message);
        if (!destroyed || attempt === retries - 1) throw err;
        console.log(chalk.yellow('[CUMATDL] Page refreshed itself; retrying evaluation...'));
        await page.waitForTimeout(1000);
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10_000 }).catch(() => {});
      }
    }
  };

  const { downloadUrls = [], serializedHtml = '' } = await evaluateWithRetry(cfg => {
    const yearExp = cfg.applyYearRewrite ? new RegExp(cfg.yearExpSource, 'i') : null;
    const urls = [];

    const baseDir = location.pathname.endsWith('/') ? location.pathname : location.pathname.replace(/[^/]+$/, '/');

    const splitSegments = pathname => pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    const baseParts = splitSegments(baseDir);

    const toRelative = targetPath => {
      const targetParts = splitSegments(targetPath);
      let i = 0;
      while (i < baseParts.length && i < targetParts.length && baseParts[i] === targetParts[i]) i++;
      const up = baseParts.slice(i).map(() => '..');
      const down = targetParts.slice(i);
      const rel = [...up, ...down].join('/');
      return rel || '.';
    };

    const normalizeUrl = href => {
      let target;
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
          (m, p1, p2) => `${p1}${cfg.yearPrefix}${cfg.courseYearDigits}${p2}`
        );
        target.pathname = newPath;
      }

      return target;
    };

    document.querySelectorAll('li').forEach(li => {
      const a = li.querySelector('a');
      if (!a) return;
      if (a.href.includes('javascript:')) {
        console.log(`[CUMATDL] Skipped JS Link: ${a.href}`);
        return;
      }
      const fixed = normalizeUrl(a.href);
      if (!fixed) return;
      const finalHref = fixed.toString();
      urls.push(finalHref);
      console.log(`[CUMATDL] URL added: ${finalHref}`);
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
  }, config);

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
    console.log(chalk.gray(`[CUMATDL] Skipped ${skipped} link(s) (staff-only or external).`));
  }

  if (serializedHtml) {
    const htmlDir = localPathFromUrl(courseChoice.href);
    const htmlPath = path.join(htmlDir, 'index.html');
    await fs.promises.mkdir(path.dirname(htmlPath), { recursive: true });
    await fs.promises.writeFile(htmlPath, serializedHtml, 'utf8');
    console.log(chalk.green(`[CUMATDL] Saved rewritten HTML: ${htmlPath}`));
  } else {
    console.log(chalk.red('[CUMATDL] Warning: no HTML captured.'));
  }

  if (!usableUrls.length) {
    console.log(chalk.yellow('No downloadable URLs detected for this course.'));
    config.missingLogger?.(`[${courseChoice.label}] No downloadable URLs detected`);
    return;
  }

  console.log(chalk.cyan(`[CUMATDL] Downloading ${usableUrls.length} file(s) for ${courseChoice.label}...`));
  for (const url of usableUrls) {
    const decoded = decodeURI(url);
    try {
      await downloadFile(decoded);
    } catch (err) {
      const message = `[${courseChoice.label}] ${decoded} :: ${err.message}`;
      console.error(chalk.red(`[CUMATDL] Failed to download ${decoded}: ${err.message}`));
      config.missingLogger?.(message);
    }
  }
}

/* ---------- main ---------- */

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    ignoreHTTPSErrors: true
  });
  const page = await browser.newPage();
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[CUMATDL]')) console.log(chalk.blue(text));
  });

  await page.goto(URL_ROOT, { waitUntil: ['domcontentloaded', 'networkidle0'] });

  const yearDirs = await page.$$eval(
    'body > table > tbody > tr > td:nth-child(2) > a',
    anchors => anchors
      .map(a => ({ text: a.textContent.trim(), href: a.href, raw: a.getAttribute('href') || '' }))
      .filter(item => item.href.endsWith('/'))
  );

  let yearChoices = yearDirs
    .map(item => {
      const seg = item.text.replace(/\/+$/, '') || item.raw.replace(/\/+$/, '').split('/').pop();
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

  console.log(chalk.bold(`\nOpening year folder: ${normalizedYear}`));
  await page.goto(yearChoice.href, { waitUntil: ['domcontentloaded', 'networkidle0'] });

  const courseDirs = await page.$$eval(
    'body > table > tbody > tr > td:nth-child(2) > a',
    anchors => anchors.map(a => ({
      href: a.href,
      raw: a.getAttribute('href') || '',
      text: a.textContent.trim()
    }))
  );

  const courseChoices = courseDirs
    .filter(item => item.href.endsWith('/'))
    .map(item => {
      const seg = segmentFromHref(item.href) || segmentFromHref(item.raw) || item.text;
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
  const missingLog = allSelected ? [] : null;
  const totalCourses = selectedCourses.length;
  let completedCourses = 0;

  for (const course of selectedCourses) {
    const injectionConfig = {
      applyYearRewrite: !skipYearRewrite,
      yearExpSource: YEAR_FIX_REGEX_SOURCE,
      yearPrefix: hasUnderscore ? '_' : '',
      courseYearDigits: courseYear,
      staffPrefix: STAFF_PREFIX,
      forceHostReplacement,
      hostNeedingFix: HOST_NEEDS_FIX,
      hostReplacement: HOST_PREFERRED,
      missingLogger: missingLog ? msg => missingLog.push(msg) : null
    };
    await processCourse(page, course, injectionConfig);
    completedCourses += 1;
    renderProgress(completedCourses, totalCourses);
  }

  if (missingLog && missingLog.length) {
    const missingPath = path.join(DOWNLOAD_ROOT, normalizedYear, 'missing.txt');
    await fs.promises.mkdir(path.dirname(missingPath), { recursive: true });
    await fs.promises.writeFile(missingPath, missingLog.join('\n') + '\n', 'utf8');
    console.log(chalk.yellow(`[CUMATDL] Missing download log saved to: ${missingPath}`));
  }

  console.log(chalk.bold('\nAll done.'));
  await browser.close();
  clearProgressLine();
})().catch(err => {
  clearProgressLine();
  console.error(chalk.red(err.stack || err));
  process.exit(1);
});