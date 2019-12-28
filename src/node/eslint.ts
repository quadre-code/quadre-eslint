import * as fs from 'fs';
import * as path from 'path';
import { CLIEngine, Linter } from 'eslint';
import { CodeInspectionReport, CodeInspectionResult, CodeInspectionResultType } from '../types';

export interface ESLintModule {
  CLIEngine: typeof CLIEngine;
}

interface QuadreLintReport extends CLIEngine.LintReport {
  eslintVersion?: string;
}

const EXTENSION_NAME = 'quadre-eslint';
const ESLINT_SEVERITY_ERROR = 2;
const ESLINT_SEVERITY_WARNING = 1;

let currentProjectRoot: string | null = null;
let currentProjectRootHasConfig: boolean = false;
let erroredLastTime: boolean = true;

const log = {
  info: (...args: any[]) => console.log('[' + EXTENSION_NAME + ']', ...args),
  warn: (...args: any[]) => console.warn('[' + EXTENSION_NAME + ']', ...args),
  error: (...args: any[]) => console.error('[' + EXTENSION_NAME + ']', ...args)
};

function getESLintModule(eslintPath: string): ESLintModule {
  let _realPath: string;
  try {
    _realPath = require.resolve(eslintPath);
  } catch (err) {
    log.error(`Wasn't able to resolve path to eslint: ${err.stack}`);
    throw new Error(`Wasn't able to resolve path to eslint.`);
  }

  let _eslint: ESLintModule;
  try {
    _eslint = require(eslintPath);
  } catch (err) {
    log.error(`Wasn't able to load eslint from ${_realPath}, be sure to run 'npm install' properly: ${err.stack}`);
    throw new Error(
      `Wasn't able to load eslint from ${_realPath}, be sure to run 'npm install' properly.`
    );
  }

  if (!_eslint.CLIEngine) {
    log.error(`No CLIEngine found for eslint loaded from ${_realPath}, which version are you using?`);
    throw new Error(`No CLIEngine found for eslint loaded from ${_realPath}, which version are you using?`);
  }

  return _eslint;
}

function uniq<T>(arr: T[]): T[] {
  return arr.reduce((result: T[], item: T) => {
    if (result.indexOf(item) === -1) {
      result.push(item);
    }
    return result;
  }, []);
}

function normalizeDir(dirPath: string) {
  if (dirPath.match(/(\\|\/)$/)) {
    dirPath = dirPath.slice(0, -1);
  }
  return process.platform === 'win32' ? dirPath.replace(/\//g, '\\') : dirPath;
}

function nodeModulesInDir(dirPath: string) {
  return path.resolve(normalizeDir(dirPath), 'node_modules');
}

const eslintModuleMap = new Map<string, ESLintModule>();
const eslintOptionsMap = new Map<string, CLIEngine.Options>();

function prepareEslintModule(
    projectRoot: string,
    prevProjectRoot: string | null,
    useEmbeddedESLint: boolean): ESLintModule {
  if (eslintModuleMap.has(projectRoot)) {
    return eslintModuleMap.get(projectRoot)!;
  }

  try {
    currentProjectRootHasConfig = fs.readdirSync(projectRoot).some((file: string) => {
      return /^\.eslintrc($|\.[a-z]+$)/i.test(file);
    });
  } catch (err) {
    log.warn(`Failed to read contents of ${projectRoot}: ${err}`);
    currentProjectRootHasConfig = false;
  }

  // only allow use of embedded eslint when no configuration is present in the project
  // or when the useEmbeddedESLint preference is set to true
  const allowEmbeddedEslint = !currentProjectRootHasConfig || useEmbeddedESLint;

  let eslintPath: string | null = 'eslint';
  if (!allowEmbeddedEslint) {
    eslintPath = projectRoot + 'node_modules/eslint';
    try {
      if (fs.statSync(eslintPath).isDirectory()) {
        // no action required
      } else {
        throw new Error('not found');
      }
    } catch (ignoreErr) {
      // Do nothing.
    }
  }

  // make sure plugins are loadable from current project directory
  const nodePath = process.env.NODE_PATH;
  let nodePaths = nodePath ? nodePath.split(path.delimiter) : [];

  // remove previous from NODE_PATH
  if (prevProjectRoot) {
    const io = nodePaths.indexOf(nodeModulesInDir(prevProjectRoot));
    if (io !== -1) {
      nodePaths.splice(io, 1);
    }
  }

  // add current to NODE_PATH
  nodePaths = [nodeModulesInDir(projectRoot)].concat(nodePaths);
  process.chdir(normalizeDir(projectRoot));

  nodePaths = uniq(nodePaths);
  process.env.NODE_PATH = nodePaths.join(path.delimiter);
  require('module').Module._initPaths();

  const eslintModule = getESLintModule(eslintPath);
  eslintModuleMap.set(projectRoot, eslintModule);
  return eslintModule;
}

function getESlintOptions(projectRoot: string): CLIEngine.Options {
  if (eslintOptionsMap.has(projectRoot)) {
    return eslintOptionsMap.get(projectRoot)!;
  }

  const opts: CLIEngine.Options = {};
  let rulesDirPath: string;
  let ignorePath: string;

  // this is critical for correct .eslintrc resolution
  opts.cwd = projectRoot;

  if (!currentProjectRootHasConfig) {
    opts.baseConfig = { extends: 'eslint:recommended' };
  }

  rulesDirPath = projectRoot + '.eslintrules';
  try {
    if (fs.statSync(rulesDirPath).isDirectory()) {
      opts.rulePaths = [rulesDirPath];
    }
  } catch (ignoreErr) {
    // no action required
  }

  ignorePath = projectRoot + '.eslintignore';
  try {
    if (fs.statSync(ignorePath).isFile()) {
      opts.ignore = true;
      opts.ignorePath = ignorePath;
    }
  } catch (ignoreErr) {
    // no action required
  }

  return opts;
}

function mapEslintMessage(result: Linter.LintMessage, majorVersion: number): CodeInspectionResult {
  const offset = majorVersion < 1 ? 0 : 1;

  let message: string;
  let type: CodeInspectionResultType;
  switch (result.severity) {
    case ESLINT_SEVERITY_ERROR:
      message = 'ERROR: ';
      type = CodeInspectionResultType.ERROR;
      break;
    case ESLINT_SEVERITY_WARNING:
      message = 'WARNING: ';
      type = CodeInspectionResultType.WARNING;
      break;
    default:
      message = 'UNKNOWN: ';
      type = CodeInspectionResultType.META;
  }

  message += result.message;
  if (result.ruleId) { message += ' [' + result.ruleId + ']'; }

  return {
    type,
    message,
    pos: {
      line: result.line - 1,
      ch: result.column - offset
    }
  };
}

function createCodeInspectionReport(eslintReport: QuadreLintReport): CodeInspectionReport {
  // if version is missing, assume 1
  const version = eslintReport.eslintVersion ? +eslintReport.eslintVersion.split('.')[0] : 1;
  const results = eslintReport.results ? eslintReport.results[0] : null;
  const messages = results ? results.messages : [];
  return {
    errors: messages.map((x: Linter.LintMessage) => mapEslintMessage(x, version))
  };
}

function createUserError(message: string): CodeInspectionReport {
  erroredLastTime = true;
  return {
    errors: [{
      type: CodeInspectionResultType.ERROR,
      message,
      pos: { line: 0, ch: 0 }
    }]
  };
}

export function lintFile(
  projectRoot: string, fullPath: string, text: string, useEmbeddedESLint: boolean,
  callback: (err: Error | null, res?: CodeInspectionReport) => void
) {
  if (erroredLastTime) {
    eslintModuleMap.delete(projectRoot);
    eslintOptionsMap.delete(projectRoot);
    erroredLastTime = false;
  }

  if (projectRoot !== currentProjectRoot) {
    if (currentProjectRoot) {
      eslintModuleMap.delete(currentProjectRoot);
      eslintOptionsMap.delete(currentProjectRoot);
    }
    currentProjectRoot = projectRoot;
  }

  let eslintModule: ESLintModule | undefined;
  let eslintOptions: CLIEngine.Options;
  try {
    eslintModule = prepareEslintModule(projectRoot, currentProjectRoot, useEmbeddedESLint);
    eslintOptions = getESlintOptions(projectRoot);
  } catch (err) {
    if (!eslintModule) {
      if (currentProjectRootHasConfig) {
        return callback(null, createUserError(
          `ESLintError: You need to install ESLint in your project folder with 'npm install eslint'`
        ));
      } else {
        return callback(null, createUserError(
          `ESLintError: No ESLint cli is available, try reinstalling the extension`
        ));
      }
    }
    return callback(null, createUserError(err.message));
  }

  if (/(\.ts|\.tsx)$/.test(fullPath) && !currentProjectRootHasConfig) {
    return callback(null, { errors: [] });
  }

  const cli = new eslintModule.CLIEngine(eslintOptions);

  const relativePath = fullPath.indexOf(projectRoot) === 0 ? fullPath.substring(projectRoot.length) : fullPath;
  let res: QuadreLintReport | undefined;
  let err: Error | null = null;
  try {
    res = cli.executeOnText(text, relativePath);
    res.eslintVersion = cli.version;
  } catch (e) {
    log.error(`Error thrown in executeOnText: ${e.stack}`);
    err = e;
    erroredLastTime = true;
  }
  return callback(err, res ? createCodeInspectionReport(res) : void 0);
}

export function fixFile(
  projectRoot: string, fullPath: string, text: string, useEmbeddedESLint: boolean,
  callback: (err: Error | null, res?: QuadreLintReport) => void
) {
  let eslintModule: ESLintModule;
  let eslintOptions: CLIEngine.Options;
  try {
    eslintModule = prepareEslintModule(projectRoot, currentProjectRoot, useEmbeddedESLint);
    eslintOptions = getESlintOptions(projectRoot);
  } catch (err) {
    return callback(err);
  }

  const cliOptions: CLIEngine.Options = {
    ...eslintOptions,
    fix: true
  };
  const cli = new eslintModule.CLIEngine(cliOptions);

  let res: QuadreLintReport | undefined;
  let err: Error | null = null;
  try {
    res = cli.executeOnText(text, fullPath);
    res.eslintVersion = cli.version;
  } catch (e) {
    log.error(e.stack);
    err = e;
  }
  callback(err, res);
}

export function configFileModified(projectRoot: string, useEmbeddedESLint: boolean) {
  eslintModuleMap.delete(projectRoot);
  eslintOptionsMap.delete(projectRoot);
  currentProjectRoot = projectRoot;
}
