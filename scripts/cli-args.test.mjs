import { describe, expect, it } from 'vitest';
import { formatOptions, parseArgs } from './cli-args.mjs';
import { CAPTURE_HELP, CAPTURE_SPEC } from './tv-capt.mjs';
import { DIAGNOSTIC_HELP, DIAGNOSTIC_SPEC } from './tv-diag.mjs';
import { EVAL_HELP, EVAL_SPEC } from './tv-eval.mjs';
import { INPUT_HELP, INPUT_SPEC } from './tv-input.mjs';
import { LOGS_HELP, LOGS_SPEC } from './tv-logs.mjs';
import { PERFORMANCE_HELP, PERFORMANCE_SPEC } from './tv-perf.mjs';

const spec = {
  commands: ['alpha', 'bravo'],
  maxPositionals: 1,
  options: {
    help: { type: 'boolean', short: 'h', default: false },
    name: { type: 'string', default: 'ch1' },
    count: { type: 'integer', min: 0, max: 9, default: 3 },
    gap: { type: 'integer', positive: true },
    ratio: { type: 'number', positive: true, max: 2 },
    shift: { type: 'number' },
    mode: { type: 'string', choices: ['fast', 'slow'] },
    at: { type: 'number', arity: 2 },
    only: { type: 'boolean', commands: ['bravo'] },
  },
};

describe('parseArgs', () => {
  it('applies defaults and reports the command', () => {
    expect(parseArgs(['alpha'], spec)).toEqual({
      command: 'alpha',
      values: { help: false, name: 'ch1', count: 3 },
      positionals: [],
      seen: [],
    });
  });

  it('parses typed values, aliases, and option order', () => {
    const result = parseArgs([
      'bravo', 'out.txt', '--count', '7', '-h', '--ratio', '1.5',
      '--mode', 'SLOW', '--only', '--name', 'ch2',
    ], spec);
    expect(result.values).toMatchObject({
      help: true, count: 7, ratio: 1.5, mode: 'slow', only: true, name: 'ch2',
    });
    expect(result.positionals).toEqual(['out.txt']);
    expect(result.seen).toEqual(['count', 'help', 'ratio', 'mode', 'only', 'name']);
  });

  it('lets the last occurrence win', () => {
    expect(parseArgs(['alpha', '--count', '1', '--count', '2'], spec).values.count).toBe(2);
  });

  it('treats negative numbers and a lone dash as values', () => {
    expect(parseArgs(['alpha', '--shift', '-3'], spec).values.shift).toBe(-3);
    expect(parseArgs(['alpha', '-3'], spec).positionals).toEqual(['-3']);
    expect(parseArgs(['alpha', '-'], spec).positionals).toEqual(['-']);
    expect(parseArgs(['alpha', '--name', '-'], spec).values.name).toBe('-');
  });

  it('collects multi-value options', () => {
    expect(parseArgs(['alpha', '--at', '10', '-20'], spec).values.at).toEqual([10, -20]);
    expect(() => parseArgs(['alpha', '--at', '10'], spec)).toThrow('--at requires 2 values');
    expect(() => parseArgs(['alpha', '--at', '1', 'x'], spec))
      .toThrow('Invalid value for --at: must be a number');
  });

  it('stops parsing options after --', () => {
    expect(parseArgs(['alpha', '--', '--count'], spec).positionals).toEqual(['--count']);
  });

  it('rejects unknown options, missing values, and bad values', () => {
    expect(() => parseArgs(['alpha', '--foo'], spec)).toThrow('Unknown option: --foo');
    expect(() => parseArgs(['alpha', '-x'], spec)).toThrow('Unknown option: -x');
    expect(() => parseArgs(['alpha', '--name=ch2'], spec)).toThrow('Unknown option: --name=ch2');
    expect(() => parseArgs(['alpha', '--name'], spec)).toThrow('--name requires a value');
    expect(() => parseArgs(['alpha', '--name', ''], spec)).toThrow('--name requires a value');
    expect(() => parseArgs(['alpha', '--name', '--count'], spec)).toThrow('--name requires a value');
    expect(() => parseArgs(['alpha', '--gap', '1.5'], spec))
      .toThrow('Invalid value for --gap: must be a positive integer');
    expect(() => parseArgs(['alpha', '--gap', '0'], spec)).toThrow(/--gap/);
    expect(() => parseArgs(['alpha', '--count', '10'], spec))
      .toThrow('Invalid value for --count: must be an integer from 0 to 9');
    expect(() => parseArgs(['alpha', '--ratio', '3'], spec))
      .toThrow('Invalid value for --ratio: must be a positive number no greater than 2');
    expect(() => parseArgs(['alpha', '--mode', 'medium'], spec))
      .toThrow('Invalid value for --mode: must be one of fast, slow');
  });

  it('rejects commands, command-only options, and extra positionals', () => {
    expect(() => parseArgs(['charlie'], spec)).toThrow('Expected a command: alpha or bravo');
    expect(() => parseArgs(['alpha', '--only'], spec)).toThrow('--only is only valid for bravo');
    expect(() => parseArgs(['alpha', 'a', 'b'], spec)).toThrow('Unexpected argument: b');
  });

  it('does not treat inherited object keys as options', () => {
    expect(() => parseArgs(['--constructor'], { options: {} }))
      .toThrow('Unknown option: --constructor');
  });
});

describe('formatOptions', () => {
  it('aligns descriptions and renders short aliases and value names', () => {
    expect(formatOptions({
      options: {
        name: { type: 'string', description: 'Channel name' },
        count: { type: 'integer', valueName: '<count>', description: 'Item count' },
        at: { type: 'number', arity: 2, description: 'Position' },
        help: { type: 'boolean', short: 'h', description: 'Show this help' },
      },
    })).toBe([
      'Options:',
      '  --name <value>   Channel name',
      '  --count <count>  Item count',
      '  --at <n> <n>     Position',
      '  -h, --help       Show this help',
    ].join('\n'));
  });

  it('appends meaningful defaults, choices, ranges, and command scopes', () => {
    expect(formatOptions({
      commands: ['alpha', 'bravo'],
      options: {
        on: { type: 'boolean', default: false, description: 'Flag' },
        path: { type: 'string', default: '', description: 'Path' },
        none: { type: 'string', default: null, description: 'None' },
        mode: { type: 'string', choices: ['fast', 'slow'], default: 'fast', description: 'Mode' },
        port: { type: 'integer', min: 1, max: 9, default: 2, description: 'Port' },
        gap: { type: 'integer', positive: true, max: 5, commands: ['bravo'], description: 'Gap' },
        skip: { type: 'integer', min: 0, description: 'Skip' },
      },
    })).toBe([
      'Options:',
      '  --on            Flag',
      '  --path <value>  Path',
      '  --none <value>  None',
      '  --mode <value>  Mode (default: fast; one of: fast, slow)',
      '  --port <n>      Port (default: 2; range: 1-9)',
      '  --gap <n>       Gap (bravo only; max: 5)',
      '  --skip <n>      Skip (min: 0)',
    ].join('\n'));
  });

  it('wraps long descriptions with a hanging indent and keeps notes whole', () => {
    const text = formatOptions({
      options: {
        'very-long-option-name': {
          type: 'string',
          valueName: '<path>',
          default: 'ch1',
          description: 'Alpha bravo charlie delta echo foxtrot golf hotel india '
            + 'juliett kilo lima mike november oscar papa quebec romeo sierra',
        },
        x: { type: 'boolean', description: 'Short' },
      },
    });
    const lines = text.split('\n');
    expect(lines[1]).toBe('  --very-long-option-name <path>');
    expect(lines.slice(2, -1).every((line) => line.startsWith(' '.repeat(26)))).toBe(true);
    expect(lines.every((line) => line.length <= 79)).toBe(true);
    expect(text).toContain('(default: ch1)');
    expect(lines.at(-1)).toBe('  --x                     Short');
  });

  it('omits hidden options and requires descriptions for shown ones', () => {
    expect(formatOptions({
      options: {
        shown: { type: 'boolean', description: 'Shown' },
        secret: { type: 'boolean', hidden: true },
      },
    })).toBe('Options:\n  --shown  Shown');
    expect(() => formatOptions({ options: { bare: { type: 'boolean' } } }))
      .toThrow('--bare needs a description');
  });
});

describe('script help', () => {
  it.each([
    ['tv-capt', CAPTURE_SPEC, CAPTURE_HELP],
    ['tv-diag', DIAGNOSTIC_SPEC, DIAGNOSTIC_HELP],
    ['tv-eval', EVAL_SPEC, EVAL_HELP],
    ['tv-input', INPUT_SPEC, INPUT_HELP],
    ['tv-logs', LOGS_SPEC, LOGS_HELP],
    ['tv-perf', PERFORMANCE_SPEC, PERFORMANCE_HELP],
  ])('%s documents every option within 79 columns', (_name, spec, help) => {
    expect(help).toContain(formatOptions(spec));
    for (const [name, option] of Object.entries(spec.options)) {
      if (!option.hidden) expect(help).toMatch(new RegExp(`^  (-\\w, )?--${name}\\b`, 'm'));
    }
    const options = formatOptions(spec).split('\n');
    expect(options.every((line) => line.length <= 79)).toBe(true);
  });
});
