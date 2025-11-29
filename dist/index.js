"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable no-console */
const axios_1 = __importDefault(require("axios"));
const chalk_1 = __importDefault(require("chalk"));
const fs_1 = __importDefault(require("fs"));
const https_1 = __importDefault(require("https"));
const log_update_1 = __importDefault(require("log-update"));
const path_1 = __importDefault(require("path"));
const puppeteer_1 = __importDefault(require("puppeteer"));
const readline_1 = __importDefault(require("readline"));
const PMA_CBROOT = 'https://www.math.cuhk.edu.hk/course_builder/';
const PMA_IP = '137.189.49.33';
const PMA_NAME = 'www.math.cuhk.edu.hk';
const ALLOWED_HOSTS = new Set([PMA_NAME, PMA_IP]);
const DOWNLOAD_ROOT = path_1.default.resolve('.');
const COURSE_PATTERN = /^[A-Za-z]{4}\d{4}.*$/;
const YEAR_PATTERN = /^_?\d{4}$/;
const YEAR_FIX_REGEX_SOURCE = '(\\/course_builder\\/)(?:_?\\d{4})(\\/)';
const STAFF_PREFIX = 'https://www.math.cuhk.edu.hk/~';
const CURRENT_YEAR = '2526';
const httpsAgent = new https_1.default.Agent({ rejectUnauthorized: false });
/* ---------- persistent progress bar ---------- */
let currentProgressLine = '';
const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);
console.log = (...args) => {
    if (currentProgressLine)
        log_update_1.default.clear();
    originalLog(...args);
    if (currentProgressLine)
        (0, log_update_1.default)(currentProgressLine);
};
console.error = (...args) => {
    if (currentProgressLine)
        log_update_1.default.clear();
    originalError(...args);
    if (currentProgressLine)
        (0, log_update_1.default)(currentProgressLine);
};
function setProgressLine(text) {
    currentProgressLine = text;
    if (currentProgressLine) {
        (0, log_update_1.default)(currentProgressLine);
    }
    else {
        log_update_1.default.clear();
    }
}
function clearProgressLine() {
    currentProgressLine = '';
    log_update_1.default.clear();
    log_update_1.default.done();
}
/* ---------- helper functions ---------- */
function prompt(question) {
    const rl = readline_1.default.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => {
        rl.close();
        resolve(answer);
    }));
}
function listChoices(items) {
    const width = String(items.length).length;
    items.forEach((item, idx) => {
        const indexLabel = `[${chalk_1.default.gray(String(idx + 1).padStart(width, ' '))}]`;
        console.log(`${indexLabel} ${chalk_1.default.cyanBright(item.displayLabel)} (${item.href})`);
    });
}
async function chooseYear(yearChoices) {
    console.log(chalk_1.default.bold('\nSelect an academic year:'));
    listChoices(yearChoices);
    while (true) {
        const rangeLabel = chalk_1.default.gray(`1-${yearChoices.length}`);
        const ans = await prompt(chalk_1.default.yellow(`Enter a number [${rangeLabel}]: `));
        const n = Number(ans);
        if (Number.isInteger(n) && n >= 1 && n <= yearChoices.length)
            return yearChoices[n - 1];
        console.log('Invalid choice. Try again.');
    }
}
function parseCourseSelection(input, max) {
    const selections = new Set();
    const chunks = input.split(',').map(s => s.trim()).filter(Boolean);
    if (!chunks.length)
        throw new Error('No valid selections provided.');
    for (const chunk of chunks) {
        const range = chunk.match(/^(\d+)\s*-\s*(\d+)$/);
        if (range) {
            let start = Number(range[1]);
            let end = Number(range[2]);
            if (!Number.isInteger(start) || !Number.isInteger(end)) {
                throw new Error(`Invalid range "${chunk}".`);
            }
            if (start > end)
                [start, end] = [end, start];
            if (start < 1 || end > max) {
                throw new Error(`Range "${chunk}" is out of bounds (1-${max}).`);
            }
            for (let i = start; i <= end; i++)
                selections.add(i - 1);
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
    console.log(chalk_1.default.bold(`\nSelect course(s):`));
    listChoices(courseChoices);
    while (true) {
        const rangeLabel = chalk_1.default.gray(`1-${courseChoices.length}`);
        const ans = await prompt(chalk_1.default.yellow(`Enter a number/list [${rangeLabel}], ranges, or ${chalk_1.default.gray("-1")} for all: `));
        const trimmed = ans.trim();
        if (trimmed === '-1') {
            console.log(chalk_1.default.greenBright('> Downloading ALL courses in this year.\n'));
            return { courses: courseChoices, allSelected: true };
        }
        try {
            const indices = parseCourseSelection(trimmed, courseChoices.length);
            return { courses: indices.map(i => courseChoices[i]), allSelected: false };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(chalk_1.default.red(message));
        }
    }
}
const segmentFromHref = (href) => href.replace(/\/+$/, '').split('/').pop() ?? '';
const normalizeYear = (seg) => (seg.startsWith('_') ? seg : `_${seg}`);
const yearDigits = (yearName) => yearName.replace(/^_/, '');
function localPathFromUrl(url) {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'course_builder')
        parts.shift();
    const decoded = parts.map(seg => decodeURIComponent(seg));
    return path_1.default.join(DOWNLOAD_ROOT, ...decoded);
}
async function downloadFile(url) {
    const localPath = localPathFromUrl(url);
    await fs_1.default.promises.mkdir(path_1.default.dirname(localPath), { recursive: true });
    if (fs_1.default.existsSync(localPath)) {
        console.log(`[${chalk_1.default.cyanBright('CUMATDL')}] ${chalk_1.default.gray("SKIP")} existing file: ${localPath}`);
        return;
    }
    const response = await axios_1.default.get(url, {
        responseType: 'arraybuffer',
        httpsAgent,
        timeout: 120000
    });
    await fs_1.default.promises.writeFile(localPath, response.data);
    console.log(`[${chalk_1.default.cyanBright('CUMATDL')}] ${chalk_1.default.greenBright("DONE")} ${localPath}`);
}
function renderProgress(completed, total, courseProgress) {
    if (total <= 0) {
        clearProgressLine();
        return;
    }
    const barLen = 24;
    const filled = Math.round((completed / total) * barLen);
    const bar = `${'█'.repeat(filled)}${'-'.repeat(barLen - filled)}`;
    const percent = ((completed / total) * 100).toFixed(1);
    const lines = [chalk_1.default.yellow(`[Overall%] [${bar}] ${completed}/${total} (${percent}%)`)];
    if (courseProgress && courseProgress.total > 0) {
        const coursePercent = ((courseProgress.downloaded / courseProgress.total) * 100).toFixed(1);
        lines.push(chalk_1.default.yellow(`[Course %] ${courseProgress.courseName}: ${courseProgress.downloaded}/${courseProgress.total} (${coursePercent}%)`));
    }
    setProgressLine(lines.join('\n'));
}
/* ---------- per course ---------- */
async function processCourse(page, courseChoice, config) {
    console.log(chalk_1.default.bold(`\nNavigating to course: ${courseChoice.label}`));
    await page.goto(courseChoice.href, { waitUntil: ['domcontentloaded', 'networkidle0'] });
    console.log(`[${chalk_1.default.cyanBright('CUMATDL')}] Year rewrite: ${config.applyYearRewrite ? 'enabled' : 'disabled'}; host fix: ${config.forceHostReplacement ? 'enabled' : 'disabled'}`);
    const evaluateWithRetry = async (fn, arg, retries = 3) => {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                return await page.evaluate(fn, arg);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const destroyed = /Execution context was destroyed|Cannot find context with specified id/i.test(message);
                if (!destroyed || attempt === retries - 1)
                    throw err;
                console.log("[Injector] Page refreshed itself; retrying evaluation...");
                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 }).catch(() => { });
            }
        }
        throw new Error('Evaluation retries exceeded');
    };
    const { downloadUrls = [], serializedHtml = '' } = await evaluateWithRetry((cfg) => {
        const yearExp = cfg.applyYearRewrite ? new RegExp(cfg.yearExpSource, 'i') : null;
        const urls = [];
        const baseDir = location.pathname.endsWith('/') ? location.pathname : location.pathname.replace(/[^/]+$/, '/');
        const splitSegments = (pathname) => pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
        const baseParts = splitSegments(baseDir);
        const toRelative = (targetPath) => {
            const targetParts = splitSegments(targetPath);
            let i = 0;
            while (i < baseParts.length && i < targetParts.length && baseParts[i] === targetParts[i])
                i++;
            const up = baseParts.slice(i).map(() => '..');
            const down = targetParts.slice(i);
            const rel = [...up, ...down].join('/');
            return rel || '.';
        };
        const normalizeUrl = (href) => {
            let target;
            try {
                target = new URL(href, location.href);
            }
            catch {
                return null;
            }
            if (cfg.forceHostReplacement && target.hostname === cfg.hostNeedingFix) {
                target.hostname = cfg.hostReplacement;
                target.port = '';
            }
            if (yearExp) {
                const newPath = target.pathname.replace(yearExp, (_match, p1, p2) => `${p1}${cfg.yearPrefix}${cfg.courseYearDigits}${p2}`);
                target.pathname = newPath;
            }
            return target;
        };
        document.querySelectorAll('li').forEach(li => {
            const a = li.querySelector('a');
            if (!a)
                return;
            if (a.href.includes('javascript:')) {
                console.log(`[Injector] SKIP JS Link: ${a.href}`);
                return;
            }
            const fixed = normalizeUrl(a.href);
            if (!fixed)
                return;
            const finalHref = fixed.toString();
            urls.push(finalHref);
            console.log(`[Injector] URL added: ${finalHref}`);
        });
        document.querySelectorAll('a[href]').forEach(a => {
            const rawHref = a.getAttribute('href');
            if (!rawHref || rawHref.startsWith('javascript:'))
                return;
            const fixed = normalizeUrl(rawHref);
            if (!fixed)
                return;
            if (fixed.href.startsWith(cfg.staffPrefix))
                return;
            if (fixed.origin === location.origin && fixed.pathname.startsWith('/course_builder/')) {
                const relPath = toRelative(fixed.pathname);
                const newHref = relPath + fixed.search + fixed.hash;
                a.setAttribute('href', newHref);
            }
            else {
                a.setAttribute('href', fixed.toString());
            }
        });
        const docHtml = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
        return { downloadUrls: urls, serializedHtml: docHtml };
    }, config);
    const usableUrls = downloadUrls.filter(url => {
        if (url.startsWith(STAFF_PREFIX))
            return false;
        try {
            const u = new URL(url);
            if (!ALLOWED_HOSTS.has(u.hostname))
                return false;
            if (!u.pathname.startsWith('/course_builder/'))
                return false;
            return true;
        }
        catch {
            return false;
        }
    });
    const skipped = downloadUrls.length - usableUrls.length;
    if (skipped) {
        console.log(`[${chalk_1.default.cyanBright('CUMATDL')}] Skipped ${skipped} link(s) (staff-only or external).`);
    }
    if (serializedHtml) {
        const htmlDir = localPathFromUrl(courseChoice.href);
        const htmlPath = path_1.default.join(htmlDir, 'index.html');
        await fs_1.default.promises.mkdir(path_1.default.dirname(htmlPath), { recursive: true });
        await fs_1.default.promises.writeFile(htmlPath, serializedHtml, 'utf8');
        console.log(`[${chalk_1.default.cyanBright('CUMATDL')}] ${chalk_1.default.greenBright("DONE")} modified index ${htmlPath}`);
    }
    else {
        console.log(`[${chalk_1.default.cyanBright('CUMATDL')}] ${chalk_1.default.red("Warning: index.html not captured.")}`);
    }
    if (!usableUrls.length) {
        console.log(`[${chalk_1.default.cyanBright('CUMATDL')}] ${chalk_1.default.yellow("No downloadable URLs detected for this course.")}`);
        config.missingLogger?.(`[${courseChoice.label}] No downloadable URLs detected`);
        return;
    }
    config.courseProgressCb?.({ courseName: courseChoice.label, downloaded: 0, total: usableUrls.length });
    console.log(`[${chalk_1.default.cyanBright('CUMATDL')}] Downloading ${usableUrls.length} file(s) for ${courseChoice.label}...`);
    for (let i = 0; i < usableUrls.length; i++) {
        const url = usableUrls[i];
        const decoded = decodeURI(url);
        try {
            await downloadFile(decoded);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const entry = `[${courseChoice.label}] ${decoded} :: ${message}`;
            console.error(`[${chalk_1.default.cyanBright('CUMATDL')}] ${chalk_1.default.red("FAIL")} ${decoded}: ${message}`);
            config.missingLogger?.(entry);
        }
        finally {
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
    const browser = await puppeteer_1.default.launch({
        headless: true,
        args: ['--ignore-certificate-errors']
    });
    const page = await browser.newPage();
    await page.goto(PMA_CBROOT, { waitUntil: ['domcontentloaded', 'networkidle0'] });
    const yearDirs = await page.$$eval('body > table > tbody > tr > td:nth-child(2) > a', anchors => anchors
        .map(a => ({
        text: a.textContent?.trim() ?? '',
        href: a.href,
        raw: a.getAttribute('href') ?? ''
    }))
        .filter(item => item.href.endsWith('/')));
    let yearChoices = yearDirs
        .map(item => {
        const seg = item.text?.replace(/\/+$/, '') ||
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
        console.error(chalk_1.default.red('No year folders found.'));
        await browser.close();
        clearProgressLine();
        return;
    }
    const yearChoice = await chooseYear(yearChoices);
    const normalizedYear = normalizeYear(yearChoice.seg);
    const hasUnderscore = yearChoice.seg.startsWith('_');
    const skipYearRewrite = yearChoice.displayLabel === CURRENT_YEAR && !hasUnderscore;
    const forceHostReplacement = yearChoice.displayLabel === CURRENT_YEAR && !hasUnderscore;
    console.log(chalk_1.default.bold(`\nOpening folder: ${normalizedYear}`));
    await page.goto(yearChoice.href, { waitUntil: ['domcontentloaded', 'networkidle0'] });
    const courseDirs = await page.$$eval('body > table > tbody > tr > td:nth-child(2) > a', anchors => anchors.map(a => ({
        href: a.href,
        raw: a.getAttribute('href') ?? '',
        text: a.textContent?.trim() ?? ''
    })));
    const courseChoices = courseDirs
        .filter(item => item.href.endsWith('/'))
        .map(item => {
        const seg = segmentFromHref(item.href) ||
            segmentFromHref(item.raw) ||
            item.text;
        return { label: seg, displayLabel: seg, href: item.href };
    })
        .filter(item => COURSE_PATTERN.test(item.label));
    if (!courseChoices.length) {
        console.error(chalk_1.default.red('No matching course folders (must start with 4 letters + 4 digits).'));
        await browser.close();
        clearProgressLine();
        return;
    }
    const { courses: selectedCourses, allSelected } = await chooseCourses(courseChoices);
    const courseYear = yearDigits(normalizedYear);
    const missingLog = allSelected ? [] : null;
    const totalCourses = selectedCourses.length;
    let completedCourses = 0;
    const updateProgress = (courseProgress) => {
        renderProgress(completedCourses, totalCourses, courseProgress);
    };
    for (const course of selectedCourses) {
        const injectionConfig = {
            applyYearRewrite: !skipYearRewrite,
            yearExpSource: YEAR_FIX_REGEX_SOURCE,
            yearPrefix: hasUnderscore ? '_' : '',
            courseYearDigits: courseYear,
            staffPrefix: STAFF_PREFIX,
            forceHostReplacement,
            hostNeedingFix: PMA_IP,
            hostReplacement: PMA_NAME,
            missingLogger: missingLog ? (msg) => missingLog.push(msg) : undefined,
            courseProgressCb: updateProgress
        };
        await processCourse(page, course, injectionConfig);
        completedCourses += 1;
        updateProgress(null); // clear per-course line, show only overall
    }
    if (missingLog && missingLog.length) {
        const missingPath = path_1.default.join(DOWNLOAD_ROOT, normalizedYear, 'missing.txt');
        await fs_1.default.promises.mkdir(path_1.default.dirname(missingPath), { recursive: true });
        await fs_1.default.promises.writeFile(missingPath, `${missingLog.join('\n')}\n`, 'utf8');
        console.log(`[${chalk_1.default.cyanBright('CUMATDL')}] Report log saved to: ${missingPath}`);
    }
    console.log(chalk_1.default.bold('\nAll done.'));
    await browser.close();
    clearProgressLine();
})().catch(err => {
    clearProgressLine();
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(chalk_1.default.red(message));
    process.exit(1);
});
