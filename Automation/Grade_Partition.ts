import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const MAX_TESTCASES = 200;
const CONTESTANT_TIME_LIMIT_MS = 1000;

const ROOT = process.cwd();
const PARTITION_BASELINE = path.join(ROOT, "Research/Base_Lines/Number_Partitioning");
const RUNS_DIR = path.join(ROOT, "Research/Runs");
const TESTCASE_DIR = path.join(ROOT, "Research/Benchmark_Testcases");
const BASELINE_CACHE_DIR = path.join(ROOT, "Research/Baseline_Outputs");

const PARTITION_RUNS = path.join(RUNS_DIR, "Number_Partitioning");
const BASELINE_TIMEOUT_PARTITION = 10000;

function ensureDirExists(dir: string) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function seededRandom(seed: number) {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

function compileCPP(sourcePath: string, outputPath: string): boolean {
    try {
        execSync(`g++ -x c++ -O3 -march=native -std=c++20 "${sourcePath}" -o "${outputPath}"`, { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

function runBinary(binaryPath: string, inputPath: string, timeoutMs: number): { success: boolean, output: string, tle: boolean } {
    try {
        const out = execSync(`"${binaryPath}" < "${inputPath}"`, { timeout: timeoutMs, stdio: ['pipe', 'pipe', 'ignore'] });
        return { success: true, output: out.toString().trim(), tle: false };
    } catch (e: any) {
        return { success: false, output: "", tle: e.code === 'ETIMEDOUT' };
    }
}

function getAiCodeFiles(dir: string): string[] {
    let results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    for (const file of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) results = results.concat(getAiCodeFiles(fullPath));
        else if (file === 'AiCode.txt') results.push(fullPath);
    }
    return results;
}

function generatePartitionTestcases() {
    const dir = path.join(TESTCASE_DIR, "Partition");
    ensureDirExists(dir);
    console.log("Generating hard testcases for Number Partitioning...");
    for (let n = 1; n <= MAX_TESTCASES; n++) {
        const file = path.join(dir, `N${n.toString().padStart(3, '0')}.in`);
        let content = `${n}\n`;
        let seed = n * 9999;
        for (let i = 0; i < n; i++) {
            const hi = Math.floor(seededRandom(seed++) * 0xFFFFFF);
            const lo = Math.floor(seededRandom(seed++) * 0xFFFFFF);
            const val = hi * 0x1000000 + lo;
            content += `${val + 1}\n`;
        }
        fs.writeFileSync(file, content);
    }
}

function runTask(taskName: string, baselineSrc: string, contestantDir: string, testcaseDirName: string, baselineTimeout: number) {
    console.log(`\n=== Processing Task: ${taskName} ===`);
    const tcDir = path.join(TESTCASE_DIR, testcaseDirName);
    const cacheDir = path.join(BASELINE_CACHE_DIR, testcaseDirName);
    ensureDirExists(cacheDir);

    const baselineBin = path.join(ROOT, `baseline_${testcaseDirName}.out`);
    console.log(`Compiling Baseline...`);
    if (!compileCPP(baselineSrc, baselineBin)) {
        console.error(`Baseline Compilation Failed: ${baselineSrc}`);
        return;
    }

    console.log(`Clearing old baseline cache...`);
    for (let n = 1; n <= MAX_TESTCASES; n++) {
        const outFile = path.join(cacheDir, `N${n.toString().padStart(3, '0')}.out`);
        if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    }

    console.log(`Finding Baseline Cutoff (Targeting ~${baselineTimeout}ms)...`);
    let maxScore = 0;
    for (let n = 1; n <= MAX_TESTCASES; n++) {
        const tcFile = path.join(tcDir, `N${n.toString().padStart(3, '0')}.in`);
        const outFile = path.join(cacheDir, `N${n.toString().padStart(3, '0')}.out`);

        const res = runBinary(baselineBin, tcFile, baselineTimeout);
        if (!res.success) {
            console.log(`Baseline failed/TLE at N=${n}. Max benchmark score: ${n - 1}`);
            maxScore = n - 1;
            break;
        }
        fs.writeFileSync(outFile, res.output);
        maxScore = n;
    }

    if (fs.existsSync(baselineBin)) fs.unlinkSync(baselineBin);

    let files = getAiCodeFiles(contestantDir);

    for (const file of files) {
        const resultsPath = path.join(path.dirname(file), 'Results');
        const displayContext = path.relative(contestantDir, path.dirname(file));

        const binPath = file.replace('.txt', '.out');
        if (!compileCPP(file, binPath)) {
            fs.writeFileSync(resultsPath, `Compilation Error\nScore: 0/${maxScore}\n`);
            console.log(`  -> ${displayContext}: Compilation Error (Score: 0/${maxScore})`);
            continue;
        }

        let passed = true;
        for (let n = 1; n <= maxScore; n++) {
            const tcFile = path.join(tcDir, `N${n.toString().padStart(3, '0')}.in`);
            const baselineOut = fs.readFileSync(
                path.join(cacheDir, `N${n.toString().padStart(3, '0')}.out`),
                'utf-8'
            ).trim();

            const res = runBinary(binPath, tcFile, CONTESTANT_TIME_LIMIT_MS);

            if (res.tle) {
                fs.writeFileSync(
                    resultsPath,
                    `TLE\nFirst failed testcase: N=${n}\nScore: ${n - 1}/${maxScore}\n`
                );
                console.log(
                    `  -> ${displayContext}: TLE at N=${n} (Score: ${n - 1}/${maxScore})`
                );
                passed = false;
                break;
            }

            if (!res.success) {
                fs.writeFileSync(
                    resultsPath,
                    `Runtime Error\nFirst failed testcase: N=${n}\nScore: 0/${maxScore}\n`
                );
                console.log(
                    `  -> ${displayContext}: RTE at N=${n} (Score: 0/${maxScore})`
                );
                passed = false;
                break;
            }

            if (res.output !== baselineOut) {
                fs.writeFileSync(
                    resultsPath,
                    `Wrong Answer\nFirst failed testcase: N=${n}\nScore: 0/${maxScore}\n`
                );
                console.log(
                    `  -> ${displayContext}: WA at N=${n} (Score: 0/${maxScore})`
                );
                passed = false;
                break;
            }
        }

        if (passed) {
            fs.writeFileSync(
                resultsPath,
                `Passed all benchmark cases\nScore: ${maxScore}/${maxScore}\n`
            );
            console.log(
                `  -> ${displayContext}: Passed all cases (Score: ${maxScore}/${maxScore})`
            );
        }

        if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
    }
}

function main() {
    generatePartitionTestcases();
    runTask(
        "Number Partitioning",
        PARTITION_BASELINE,
        PARTITION_RUNS,
        "Partition",
        BASELINE_TIMEOUT_PARTITION
    );
}

main();
