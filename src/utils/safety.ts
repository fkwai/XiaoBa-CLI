import * as path from 'path';

const DANGEROUS_TOOL_ALLOW_ENV = 'GAUZ_TOOL_ALLOW';
const BASH_ALLOW_DANGEROUS_ENV = 'GAUZ_BASH_ALLOW_DANGEROUS';
const FS_ALLOW_OUTSIDE_ENV = 'GAUZ_FS_ALLOW_OUTSIDE';
const FS_ALLOW_OUTSIDE_READ_ENV = 'GAUZ_FS_ALLOW_OUTSIDE_READ';
const FS_ALLOW_DOTENV_ENV = 'GAUZ_FS_ALLOW_DOTENV';

const DEFAULT_DANGEROUS_TOOLS = new Set([
  'execute_shell',
  'execute_bash',
  'write_file',
  'edit_file',

  'self_evolution'
]);

const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\s+\/(\s|$)/i, reason: '检测到可能破坏系统的 rm -rf /' },
  { pattern: /\bdel\s+\/s\s+\/q\s+[a-z]:\\/i, reason: '检测到可能清空磁盘的 del /s /q' },
  { pattern: /\bformat(\.exe)?\s+[a-z]:/i, reason: '检测到磁盘格式化命令' },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: '检测到文件系统格式化命令' },
  { pattern: /\bdiskpart\b/i, reason: '检测到磁盘分区工具' },
  { pattern: /\bdd\s+.+\bof=\/dev\//i, reason: '检测到可能直接写入块设备的 dd 命令' },
  { pattern: /\bshutdown\b/i, reason: '检测到关机/重启命令' },
  { pattern: /\breboot\b/i, reason: '检测到重启命令' },
  { pattern: /\bpoweroff\b/i, reason: '检测到关机命令' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/, reason: '检测到 Fork Bomb' }
];

const CONFIRMABLE_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-(?:[^\s-]*r[^\s-]*f|[^\s-]*f[^\s-]*r)\s+(?!\/(?:\s|$))/i, reason: '检测到递归强制删除命令' },
  { pattern: /\bRemove-Item\b(?=[\s\S]*-(?:Recurse|r)\b)(?=[\s\S]*-(?:Force|f)\b)/i, reason: '检测到 PowerShell 递归强制删除命令' },
  { pattern: /\brmdir\s+\/s\s+\/q\b/i, reason: '检测到 Windows 递归删除目录命令' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: '检测到会丢弃工作区改动的 git reset --hard' },
  { pattern: /\bgit\s+clean\s+-(?:[a-z]*f[a-z]*d|[a-z]*d[a-z]*f)/i, reason: '检测到会删除未跟踪文件的 git clean' },
  { pattern: /\bgit\s+(?:checkout|switch)\s+-(?:[a-z]*f|force)\b/i, reason: '检测到强制切换分支/工作区命令' },
  { pattern: /\bgit\s+push\b[\s\S]*--force(?:-with-lease)?\b/i, reason: '检测到强制推送命令' },
  { pattern: /\bgit\s+branch\s+-D\b/i, reason: '检测到强制删除分支命令' },
  { pattern: /\bnpm\s+publish\b/i, reason: '检测到发布 npm 包命令' },
  { pattern: /\bpip\s+install\b[\s\S]*(?:--force-reinstall|--upgrade)\b/i, reason: '检测到会改动 Python 环境的 pip 安装命令' },
];

export interface SafetyCheckOptions {
  confirmed?: boolean;
  env?: NodeJS.ProcessEnv;
}

function parseAllowedTools(): Set<string> {
  const raw = (process.env[DANGEROUS_TOOL_ALLOW_ENV] || '').trim();
  if (!raw) return new Set();
  const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
  const allowed = new Set(parts);

  // execute_shell 和 execute_bash 视为等价，避免迁移期配置失效
  if (allowed.has('execute_bash')) {
    allowed.add('execute_shell');
  }
  if (allowed.has('execute_shell')) {
    allowed.add('execute_bash');
  }
  return allowed;
}

export function isToolAllowed(toolName: string): { allowed: boolean; reason?: string } {
  // 如果不在危险工具列表中，直接允许
  if (!DEFAULT_DANGEROUS_TOOLS.has(toolName)) {
    return { allowed: true };
  }

  // 检查是否通过环境变量明确允许
  const allowedTools = parseAllowedTools();
  if (allowedTools.has(toolName)) {
    return { allowed: true };
  }

  // 危险工具未在允许列表中
  return {
    allowed: false,
    reason: `工具 ${toolName} 被标记为危险工具。如需启用，请设置 ${DANGEROUS_TOOL_ALLOW_ENV}=${toolName} 或 ${DANGEROUS_TOOL_ALLOW_ENV}=${Array.from(DEFAULT_DANGEROUS_TOOLS).join(',')}`
  };
}

export function isBashCommandAllowed(
  command: string,
  options: SafetyCheckOptions = {},
): { allowed: boolean; reason?: string } {
  const env = options.env ?? process.env;
  if (env[BASH_ALLOW_DANGEROUS_ENV] === 'true') {
    // 记录警告日志，提醒用户已禁用 shell 安全检查
    console.warn(
      `[WARNING] Shell safety checks have been bypassed via ${BASH_ALLOW_DANGEROUS_ENV}=true. ` +
      `This disables protection against dangerous commands like 'rm -rf /'. ` +
      `Use this only in trusted environments.`
    );
    return { allowed: true };
  }

  for (const rule of DANGEROUS_BASH_PATTERNS) {
    if (rule.pattern.test(command)) {
      return {
        allowed: false,
        reason: `${rule.reason}。如需强制执行，请设置 ${BASH_ALLOW_DANGEROUS_ENV}=true`
      };
    }
  }

  for (const rule of CONFIRMABLE_BASH_PATTERNS) {
    if (rule.pattern.test(command) && !options.confirmed) {
      return {
        allowed: false,
        reason: `${rule.reason}。请先确认用户明确要求该危险操作，再用 confirm_dangerous=true 重试；如需强制绕过全部 shell 安全检查，请设置 ${BASH_ALLOW_DANGEROUS_ENV}=true`
      };
    }
  }

  return { allowed: true };
}

function isOutsideWorkingDirectory(targetPath: string, workingDirectory: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedCwd = path.resolve(workingDirectory);

  if (resolvedTarget === resolvedCwd) {
    return false;
  }

  const normalizedTarget = resolvedTarget.toLowerCase();
  const normalizedCwd = resolvedCwd.toLowerCase();
  const cwdWithSep = normalizedCwd.endsWith(path.sep) ? normalizedCwd : normalizedCwd + path.sep;
  return !normalizedTarget.startsWith(cwdWithSep);
}

export function isReadPathAllowed(targetPath: string, workingDirectory: string): { allowed: boolean; reason?: string } {
  if (!isOutsideWorkingDirectory(targetPath, workingDirectory)) {
    return { allowed: true };
  }

  // 路径在工作目录外，检查是否允许
  if (process.env[FS_ALLOW_OUTSIDE_READ_ENV] === 'true') {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `路径 ${targetPath} 位于工作目录 ${workingDirectory} 之外。如需读取外部路径，请设置 ${FS_ALLOW_OUTSIDE_READ_ENV}=true`
  };
}

export function isPathAllowed(targetPath: string, workingDirectory: string): { allowed: boolean; reason?: string } {
  if (process.env[FS_ALLOW_DOTENV_ENV] !== 'true' && isDotEnvPath(targetPath)) {
    return {
      allowed: false,
      reason: `检测到写入敏感环境文件 ${path.basename(targetPath)}。如确需修改，请设置 ${FS_ALLOW_DOTENV_ENV}=true`
    };
  }
  return { allowed: true };
}

function isDotEnvPath(targetPath: string): boolean {
  return /^\.env(?:\.|$)/i.test(path.basename(targetPath));
}
