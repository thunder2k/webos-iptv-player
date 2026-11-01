// Declarative argv parser shared by the host-side tv-*.mjs scripts.
//
// parseArgs(argv, {
//   commands: ['screenshot', 'record'], // optional; argv[0] must be one
//   maxPositionals: 1,                  // default: unlimited
//   options: {
//     help: { type: 'boolean', short: 'h' },
//     port: { type: 'integer', min: 1, max: 65535, default: 9998 },
//     fps: { type: 'integer', positive: true, max: 10, commands: ['record'] },
//     method: { type: 'string', choices: ['blended', 'display'] },
//     at: { type: 'number', arity: 2 },
//   },
// }) -> { command, values, positionals, seen }
//
// `values` is keyed by long name; `seen` lists option names in argv order.
// A lone `-` and negative numbers are values; `--` ends option parsing.
// formatOptions(spec) renders the help Options section from `description`,
// optional `valueName` (e.g. '<path>'), `hidden`, and the constraints above.

const looksLikeOption = (arg) => arg.length > 1 && arg[0] === '-'
  && !Number.isFinite(Number(arg));

const describeNumber = ({ type, positive, min, max }) => {
  const kind = type === 'integer' ? 'integer' : 'number';
  let text = positive ? `a positive ${kind}` : `${kind === 'integer' ? 'an' : 'a'} ${kind}`;
  if (min !== undefined && max !== undefined) text += ` from ${min} to ${max}`;
  else if (min !== undefined) text += ` no less than ${min}`;
  else if (max !== undefined) text += ` no greater than ${max}`;
  return text;
};

const convert = (raw, flag, spec) => {
  if (spec.type === 'string') {
    if (!spec.choices) return raw;
    const match = spec.choices.find((choice) => choice.toLowerCase() === raw.toLowerCase());
    if (match === undefined) {
      throw new Error(`Invalid value for ${flag}: must be one of ${spec.choices.join(', ')}`);
    }
    return match;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)
      || (spec.type === 'integer' && !Number.isInteger(value))
      || (spec.positive && value <= 0)
      || (spec.min !== undefined && value < spec.min)
      || (spec.max !== undefined && value > spec.max)) {
    throw new Error(`Invalid value for ${flag}: must be ${describeNumber(spec)}`);
  }
  return value;
};

export function parseArgs(argv, { commands, options = {}, maxPositionals = Infinity } = {}) {
  const shorts = new Map();
  const values = {};
  for (const [name, spec] of Object.entries(options)) {
    if (spec.short) shorts.set(`-${spec.short}`, name);
    if (spec.default !== undefined) values[name] = spec.default;
  }
  const positionals = [];
  const seen = [];
  let command = null;
  let index = 0;
  if (commands) {
    command = argv[0];
    if (!commands.includes(command)) {
      throw new Error(`Expected a command: ${commands.join(' or ')}`);
    }
    index = 1;
  }

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!looksLikeOption(arg)) {
      positionals.push(arg);
      continue;
    }
    const name = arg.startsWith('--') ? arg.slice(2) : shorts.get(arg);
    const spec = name !== undefined && Object.hasOwn(options, name) ? options[name] : null;
    if (!spec) throw new Error(`Unknown option: ${arg}`);
    const flag = `--${name}`;
    if (spec.commands && !spec.commands.includes(command)) {
      throw new Error(`${flag} is only valid for ${spec.commands.join(' or ')}`);
    }
    seen.push(name);
    if (spec.type === 'boolean') {
      values[name] = true;
      continue;
    }
    const arity = spec.arity ?? 1;
    const parsed = [];
    for (let n = 0; n < arity; n += 1) {
      const raw = argv[index + 1];
      if (raw === undefined || raw === '' || looksLikeOption(raw)) {
        throw new Error(`${flag} requires ${arity > 1 ? `${arity} values` : 'a value'}`);
      }
      parsed.push(convert(raw, flag, spec));
      index += 1;
    }
    values[name] = arity > 1 ? parsed : parsed[0];
  }

  if (positionals.length > maxPositionals) {
    throw new Error(`Unexpected argument: ${positionals[maxPositionals]}`);
  }
  return { command, values, positionals, seen };
}

const HELP_WIDTH = 79;
const LABEL_WIDTH = 22;

const wrap = (text, indent) => {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && indent + line.length + 1 + word.length > HELP_WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(line);
  return lines.join(`\n${' '.repeat(indent)}`).replace(/\u00a0/g, ' ');
};

const notes = (spec) => {
  const parts = [];
  if (spec.commands) parts.push(`${spec.commands.join(' or ')} only`);
  const { default: value } = spec;
  if (value !== undefined && value !== null && value !== '' && value !== false) {
    parts.push(`default: ${String(value)}`);
  }
  if (spec.choices) parts.push(`one of: ${spec.choices.join(', ')}`);
  if (spec.min !== undefined && spec.max !== undefined) {
    parts.push(`range: ${spec.min}-${spec.max}`);
  } else if (spec.max !== undefined) {
    parts.push(`max: ${spec.max}`);
  } else if (spec.min !== undefined) {
    parts.push(`min: ${spec.min}`);
  }
  // Keep each `key: value` note on one line when wrapping.
  return parts.length ? ` (${parts.join('; ').replace(/: /g, ':\u00a0')})` : '';
};

export function formatOptions({ options = {} } = {}) {
  const rows = Object.entries(options)
    .filter(([, spec]) => !spec.hidden)
    .map(([name, spec]) => {
      if (!spec.description) throw new Error(`--${name} needs a description`);
      const valueName = spec.valueName ?? (spec.type === 'string' ? '<value>' : '<n>');
      const values = spec.type === 'boolean'
        ? ''
        : ` ${Array(spec.arity ?? 1).fill(valueName).join(' ')}`;
      const label = `${spec.short ? `-${spec.short}, ` : ''}--${name}${values}`;
      return { label, text: `${spec.description}${notes(spec)}` };
    });
  const labelWidth = Math.min(LABEL_WIDTH, Math.max(0, ...rows.map(({ label }) => label.length)));
  const indent = 2 + labelWidth + 2;
  const lines = rows.map(({ label, text }) => {
    const body = wrap(text, indent);
    return label.length > labelWidth
      ? `  ${label}\n${' '.repeat(indent)}${body}`
      : `  ${label.padEnd(labelWidth)}  ${body}`;
  });
  return `Options:\n${lines.join('\n')}`;
}
