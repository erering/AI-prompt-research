import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';

const CONTESTANT_TIME_LIMIT_MS = 1000;
const BASELINE_TIMEOUT_CLIQUE = 10000;

const ROOT = process.cwd();
const CLIQUE_BASELINE = path.join(ROOT, "Research/Base_Lines/Maximum_Clique_Size");
const RUNS_DIR = path.join(ROOT, "Research/Runs");
const TESTCASE_DIR = path.join(ROOT, "Research/Benchmark_Testcases");
const BASELINE_CACHE_DIR = path.join(ROOT, "Research/Baseline_Outputs");
const CLIQUE_RUNS = path.join(RUNS_DIR, "Maximum_Clique_Size");
const TMP_DIR = path.join(ROOT, "tmp_bins");

function ensureDirExists(dir: string) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function seededRandom(seed: number): number {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

function compileCPP(sourcePath: string, outputPath: string): boolean {
    const result = spawnSync('g++-16', ['-x', 'c++', '-O3', '-march=native', '-std=c++20', sourcePath, '-o', outputPath], { encoding: 'utf-8' });
    return result.status === 0;
}

function runBinary(binaryPath: string, inputPath: string, timeoutMs: number): { success: boolean, output: string, tle: boolean } {
    const input = fs.readFileSync(inputPath);
    const result = spawnSync(binaryPath, [], { input, timeout: timeoutMs, encoding: 'utf-8' });
    if (result.signal === 'SIGTERM' || result.error?.message?.includes('ETIMEDOUT')) {
        return { success: false, output: '', tle: true };
    }
    if (result.status !== 0 || result.error) {
        return { success: false, output: '', tle: false };
    }
    return { success: true, output: (result.stdout ?? '').trim(), tle: false };
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

function generateTestcase(n: number, tcDir: string): string {
    const file = path.join(tcDir, `N${n.toString().padStart(3, '0')}.in`);
    const edgeProb = n === 1 ? 1.0 : Math.exp(-Math.log(n) / n);
    let seed = n * 9999;
    const adj: boolean[][] = Array.from({ length: n }, () => new Array(n).fill(false));
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (seededRandom(seed++) < edgeProb) {
                adj[i][j] = true;
                adj[j][i] = true;
            }
        }
    }
    let content = `${n}\n`;
    for (let i = 0; i < n; i++) {
        let row = '';
        for (let j = 0; j < n; j++) {
            row += (i !== j && adj[i][j]) ? '1' : '0';
        }
        content += row + '\n';
    }
    fs.writeFileSync(file, content);
    return file;
}

function runCliqueTask() {
    console.log(`\n=== Processing Task: Maximum Clique Size ===`);

    const tcDir = path.join(TESTCASE_DIR, "Clique");
    const cacheDir = path.join(BASELINE_CACHE_DIR, "Clique");
    ensureDirExists(tcDir);
    ensureDirExists(cacheDir);
    ensureDirExists(TMP_DIR);

    const baselineBin = path.join(TMP_DIR, "baseline_Clique.out");
    console.log("Compiling Baseline...");
    if (!compileCPP(CLIQUE_BASELINE, baselineBin)) {
        console.error(`Baseline Compilation Failed: ${CLIQUE_BASELINE}`);
        return;
    }

    console.log("Clearing old baseline cache...");
    for (const f of fs.readdirSync(cacheDir)) fs.unlinkSync(path.join(cacheDir, f));

    console.log(`Generating testcases and finding baseline cutoff (10s limit per testcase)...`);
    let maxScore = 0;
    for (let n = 1; ; n++) {
        const tcFile = generateTestcase(n, tcDir);
        const outFile = path.join(cacheDir, `N${n.toString().padStart(3, '0')}.out`);
        const res = runBinary(baselineBin, tcFile, BASELINE_TIMEOUT_CLIQUE);
        if (!res.success) {
            console.log(`Baseline failed/TLE at N=${n}. Max benchmark score: ${n - 1}`);
            maxScore = n - 1;
            break;
        }
        fs.writeFileSync(outFile, res.output);
        maxScore = n;
        console.log(`  Baseline passed N=${n}`);
    }
    if (fs.existsSync(baselineBin)) fs.unlinkSync(baselineBin);

    const files = getAiCodeFiles(CLIQUE_RUNS);
    console.log(`\nFound ${files.length} AiCode.txt files to grade.`);

    let binCounter = 0;
    for (const file of files) {
        const resultsPath = path.join(path.dirname(file), 'Results');
        const displayContext = path.relative(CLIQUE_RUNS, path.dirname(file));
        const binPath = path.join(TMP_DIR, `contestant_${binCounter++}.out`);

        if (!compileCPP(file, binPath)) {
            fs.writeFileSync(resultsPath, `Compilation Error\nScore: 0/${maxScore}\n`);
            console.log(`  -> ${displayContext}: Compilation Error (Score: 0/${maxScore})`);
            continue;
        }

        let verdict = 'passed';
        let failN = -1;
        let failReason = '';

        for (let n = 1; n <= maxScore; n++) {
            const tcFile = path.join(tcDir, `N${n.toString().padStart(3, '0')}.in`);
            const baselineOut = fs.readFileSync(path.join(cacheDir, `N${n.toString().padStart(3, '0')}.out`), 'utf-8').trim();
            const res = runBinary(binPath, tcFile, CONTESTANT_TIME_LIMIT_MS);

            if (res.tle) {
                verdict = 'tle'; failN = n; break;
            }
            if (!res.success || res.output !== baselineOut) {
                verdict = 'wrong'; failN = n;
                failReason = !res.success ? 'Runtime Error' : 'Wrong Answer';
                break;
            }
        }

        if (fs.existsSync(binPath)) fs.unlinkSync(binPath);

        if (verdict === 'passed') {
            fs.writeFileSync(resultsPath, `Passed all benchmark cases\nScore: ${maxScore}/${maxScore}\n`);
            console.log(`  -> ${displayContext}: Passed all cases (Score: ${maxScore}/${maxScore})`);
        } else if (verdict === 'tle') {
            fs.writeFileSync(resultsPath, `TLE\nFirst failed testcase: N=${failN}\nScore: ${failN - 1}/${maxScore}\n`);
            console.log(`  -> ${displayContext}: TLE at N=${failN} (Score: ${failN - 1}/${maxScore})`);
        } else {
            fs.writeFileSync(resultsPath, `${failReason}\nFirst failed testcase: N=${failN}\nScore: 0/${maxScore}\n`);
            console.log(`  -> ${displayContext}: ${failReason} at N=${failN} (Score: 0/${maxScore})`);
        }
    }
}

runCliqueTask();
