import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { IacFile, TARGET_ENVS, TargetEnv } from './iac-bundle';

const run = promisify(execFile);

export interface IacDiagnostic { file: string; line: number; column: number; level: 'error' | 'warning' | 'info'; code: string; message: string }

/** Result of `bicep build`, `bicep lint` and `bicep build-params` over the bundle (spec 4.5). */
export interface IacValidation {
  status: 'passed' | 'failed' | 'skipped';
  tool: string | null;
  checkedAt: string;
  commands: string[];
  diagnostics: IacDiagnostic[];
  reason: string | null;
}

const LINE = /^(.*?)\((\d+),(\d+)\)\s*:\s*(Error|Warning|Info)\s+([^:\s]+):\s*(.*)$/;

/** Parses Bicep CLI diagnostics (`file(line,col) : Level code: message`), relative to the bundle root, without duplicates. */
export function parseBicepDiagnostics(output: string, root: string, known: string[] = []): IacDiagnostic[] {
  const seen = new Set<string>();
  const out: IacDiagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    // The CLI may print the long form of a short (8.3) temp path, so match the bundle's own paths first.
    const abs = m[1].replace(/\\/g, '/');
    const file = known.find((k) => abs.endsWith(`/${k}`)) ?? (path.relative(root, m[1]).replace(/\\/g, '/') || m[1]);
    const d: IacDiagnostic = { file, line: Number(m[2]), column: Number(m[3]), level: m[4].toLowerCase() as IacDiagnostic['level'], code: m[5], message: m[6].replace(/\s*\[https?:\/\/\S+\]\s*$/, '') };
    const key = `${d.file}:${d.line}:${d.column}:${d.code}`;
    if (!seen.has(key)) { seen.add(key); out.push(d); }
  }
  return out;
}

/** Writes the bundle's files under `root`, refusing any path that would land outside it. */
async function writeBundle(root: string, files: IacFile[]): Promise<void> {
  for (const f of files) {
    const target = path.join(root, f.path);
    if (!target.startsWith(root + path.sep)) throw new Error(`Refusing to write outside the bundle: ${f.path}`);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, f.content, 'utf8');
  }
}

/** One environment of a bundle compiled to what ARM accepts: the JSON template and its parameter values. */
export interface ArmDeploymentInput {
  template: Record<string, unknown>;
  parameters: Record<string, { value: unknown }>;
  tool: string;
}

export class IacCompileError extends Error {}

/**
 * Compiles `infra/params/<env>.bicepparam` (and through it main.bicep and the AVM modules) into an
 * ARM template and parameters with `bicep build-params --stdout` - for a live what-if or deployment
 * of exactly these bytes. Needs the Bicep CLI; no shell.
 */
export async function compileForArm(files: IacFile[], env: TargetEnv, bicepPath: string | undefined, timeoutMs = 240_000): Promise<ArmDeploymentInput> {
  if (!bicepPath) throw new IacCompileError('Live what-if and deployment need the Bicep CLI on this server (AZURE_BUILDER_BICEP_PATH).');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'azb-arm-'));
  try {
    await writeBundle(root, files);
    const tool = (await run(bicepPath, ['--version'], { timeout: 30_000 })).stdout.trim();
    let stdout: string;
    try {
      ({ stdout } = await run(bicepPath, ['build-params', `infra/params/${env}.bicepparam`, '--stdout'], { cwd: root, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }));
    } catch (err) {
      const e = err as { stderr?: string; killed?: boolean; message: string };
      const errors = parseBicepDiagnostics(e.stderr ?? '', root, files.map((f) => f.path)).filter((d) => d.level === 'error');
      throw new IacCompileError(e.killed ? 'The Bicep compile timed out.' : `The ${env} parameters did not compile: ${errors.map((d) => `${d.file}(${d.line}) ${d.message}`).join('; ') || (e.stderr || e.message).trim().split(/\r?\n/)[0]}`);
    }
    const out = JSON.parse(stdout) as { templateJson?: string; parametersJson?: string };
    if (!out.templateJson || !out.parametersJson) throw new IacCompileError('bicep build-params returned no template or parameters.');
    const parameters = (JSON.parse(out.parametersJson) as { parameters?: Record<string, { value: unknown }> }).parameters ?? {};
    return { template: JSON.parse(out.templateJson), parameters, tool };
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

/**
 * Compiles and lints the bundle with the Bicep CLI at `bicepPath` (no shell; generated
 * files only). Without a CLI the result is "skipped" - never reported as passed.
 */
export async function validateIacBundle(files: IacFile[], bicepPath: string | undefined, timeoutMs = 240_000): Promise<IacValidation> {
  const checkedAt = new Date().toISOString();
  if (!bicepPath) {
    return { status: 'skipped', tool: null, checkedAt, commands: [], diagnostics: [], reason: 'The Bicep CLI is not configured on this server (AZURE_BUILDER_BICEP_PATH). Run `bicep build infra/main.bicep` before deploying; the pipeline lints it too.' };
  }
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'azb-iac-'));
  const commands: string[][] = [
    ['build', 'infra/main.bicep', '--stdout'],
    ['lint', 'infra/main.bicep'],
    ...TARGET_ENVS.map((env) => ['build-params', `infra/params/${env}.bicepparam`, '--stdout']),
  ];
  try {
    await writeBundle(root, files);
    let output = '';
    let version = '';
    try {
      version = (await run(bicepPath, ['--version'], { timeout: 30_000 })).stdout.trim();
    } catch (err) {
      return { status: 'skipped', tool: null, checkedAt, commands: [], diagnostics: [], reason: `The Bicep CLI at AZURE_BUILDER_BICEP_PATH could not be run: ${(err as Error).message}` };
    }
    for (const args of commands) {
      try {
        const r = await run(bicepPath, args, { cwd: root, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
        output += `${r.stderr}\n`;
      } catch (err) {
        const e = err as { stderr?: string; stdout?: string; killed?: boolean; message: string };
        if (e.killed) throw new Error(`bicep ${args.join(' ')} timed out`);
        output += `${e.stderr ?? ''}\n${e.stdout ?? ''}\n`;
        if (!LINE.test((e.stderr ?? '').split(/\r?\n/).find((l) => LINE.test(l.trim()))?.trim() ?? '')) output += `${args[1]}(1,1) : Error bicep-cli: ${(e.stderr || e.message).trim().split(/\r?\n/)[0]}\n`;
      }
    }
    const diagnostics = parseBicepDiagnostics(output, root, files.map((f) => f.path));
    return {
      status: diagnostics.some((d) => d.level === 'error') ? 'failed' : 'passed',
      tool: version,
      checkedAt,
      commands: commands.map((a) => `bicep ${a.join(' ')}`),
      diagnostics,
      reason: null,
    };
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}
