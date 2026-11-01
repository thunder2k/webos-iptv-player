import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KEYS,
  broadcastAddresses,
  cacheFile,
  evdevBackend,
  magicPacket,
  normalizeMac,
  parseArpMac,
  parseTvMac,
  learnMac,
  wakeTv,
  POINTER_GAIN,
  parseInputArgs,
  readCachedMac,
  writeCachedMac,
  planAxis,
  planMove,
  remoteCommand,
  withGaps,
} from './tv-input.mjs';

const helper = createRequire(import.meta.url)('./tv-input-remote.js');

const pixelsFor = (steps) => steps.reduce((sum, step) => {
  const [, pixels] = POINTER_GAIN.find(([size]) => size === Math.abs(step));
  return sum + Math.sign(step) * pixels;
}, 0);

describe('TV input arguments', () => {
  it('shows help without arguments', () => {
    expect(parseInputArgs([])).toEqual({ help: true });
    expect(parseInputArgs(['key', 'ok', '--help'])).toEqual({ help: true });
  });

  it('parses keys with a gap', () => {
    expect(parseInputArgs(['key', 'red', 'down', '5', '--gap', '80'])).toMatchObject({
      command: 'key', keys: ['red', 'down', '5'], gap: 80, cdp: false,
    });
  });

  it('rejects an unknown key', () => {
    expect(() => parseInputArgs(['key', 'menu'])).toThrow(/unknown key menu/);
  });

  it('parses move, click, wheel, and the CDP backend', () => {
    expect(parseInputArgs(['move', '10', '20'])).toMatchObject({ command: 'move', to: { x: 10, y: 20 } });
    expect(parseInputArgs(['click'])).toMatchObject({ command: 'click', to: undefined });
    expect(parseInputArgs(['click', '5', '6', '--cdp'])).toMatchObject({
      command: 'click', to: { x: 5, y: 6 }, cdp: true,
    });
    expect(parseInputArgs(['wheel', '-3', '--at', '700', '450'])).toMatchObject({
      command: 'wheel', notches: -3, at: { x: 700, y: 450 },
    });
    expect(parseInputArgs(['pos', '--app', 'ch1', '--cdp'])).toMatchObject({
      command: 'pos', app: 'ch1', cdp: true, gap: 150,
    });
    expect(() => parseInputArgs(['--cdp', 'pos'])).toThrow(/Expected a command/);
  });

  it('rejects coordinates off the 1920x1080 canvas', () => {
    expect(() => parseInputArgs(['move', '1920', '0'])).toThrow(/x must be from 0 to 1919/);
    expect(() => parseInputArgs(['move', '0', '-1'])).toThrow(/y must be from 0 to 1079/);
    expect(() => parseInputArgs(['wheel', '0'])).toThrow(/notches must not be 0/);
    expect(() => parseInputArgs(['wheel', '1', '--at', '0', '1080'])).toThrow(/--at y must be from 0 to 1079/);
  });

  it('parses wake and keeps its options to wake', () => {
    expect(parseInputArgs(['wake'])).toMatchObject({
      command: 'wake', timeout: 90, wait: true, learn: false,
    });
    expect(parseInputArgs(['wake', '--timeout', '30', '--no-wait'])).toMatchObject({
      command: 'wake', timeout: 30, wait: false,
    });
    expect(parseInputArgs(['wake', '--learn'])).toMatchObject({ command: 'wake', learn: true });
    expect(() => parseInputArgs(['wake', '--timeout', '0'])).toThrow(/positive number/);
    expect(() => parseInputArgs(['wake', 'now'])).toThrow(/wake takes no arguments/);
    expect(() => parseInputArgs(['wake', '--cdp'])).toThrow(/--cdp cannot wake/);
    expect(() => parseInputArgs(['key', 'ok', '--no-wait'])).toThrow(/--no-wait is only valid for wake/);
    expect(() => parseInputArgs(['move', '1', '1', '--gap', '5'])).toThrow(/--gap is only valid for key or wheel/);
    expect(() => parseInputArgs(['key', 'up', '--at', '1', '1'])).toThrow(/--at is only valid for wheel/);
  });
});

describe('TV input key map', () => {
  it('maps the remote keys the app handles to their DOM key codes', () => {
    expect(KEYS.get('back')).toEqual([412, 461]);
    expect(KEYS.get('ok')).toEqual([28, 13]);
    expect(['red', 'green', 'yellow', 'blue'].map((name) => KEYS.get(name)[1])).toEqual([403, 404, 405, 406]);
    expect(KEYS.get('0')).toEqual([11, 48]);
    expect(KEYS.get('9')).toEqual([10, 57]);
  });

  it('sends power only through the TV input devices', () => {
    expect(KEYS.get('power')).toEqual([116, null]);
    expect(parseInputArgs(['key', 'power'])).toMatchObject({ command: 'key', keys: ['power'] });
    expect(() => parseInputArgs(['key', 'power', '--cdp'])).toThrow(/--cdp cannot send power/);
  });
});

describe('TV pointer planning', () => {
  it('plans steps that cover the distance exactly', () => {
    for (const distance of [0, 1, 7, 58, 123, 640, -1, -37, -960]) {
      const steps = planAxis(distance);
      expect(Math.abs(pixelsFor(steps) - distance)).toBe(0);
    }
  });

  it('moves each axis separately', () => {
    expect(planMove({ x: 0, y: 100 }, { x: 59, y: 98 })).toEqual(['m:16,0', 'm:1,0', 'm:0,-2']);
  });
});

describe('TV remote command', () => {
  it('spaces repeated steps with sleeps', () => {
    expect(withGaps(['k:1', 'k:2', 'k:3'], 50)).toEqual(['k:1', 's:50', 'k:2', 's:50', 'k:3']);
    expect(withGaps(['k:1', 'k:2'], 0)).toEqual(['k:1', 'k:2']);
  });

  it('sends the helper source inline to the TV Node.js', () => {
    const command = remoteCommand(['k:108', 'w:1@700,450'], "var a = 'b';");
    expect(command).toBe(`node -e 'var a = '\\''b'\\'';' k:108 w:1@700,450`);
  });
});

describe('TV input helper', () => {
  const devices = [
    'I: Bus=0000\nN: Name="LGE RCU"\nH: Handlers=kbd event0 ',
    'N: Name="LGE M-RCU - Builtin [1]"\nH: Handlers=kbd js1 event4 ',
    'N: Name="LGE M-RCU - Builtin [0]"\nH: Handlers=kbd js0 event3 ',
    'N: Name="ClickableMouse"\nH: Handlers=js6 event9 ',
  ].join('\n\n');

  it('reports a device missing after a pause as a clean error and closes what it opened', async () => {
    const closed = [];
    const io = {
      readFileSync: () => devices.split('\n\n')[0],
      openSync: () => 7,
      writeSync: () => {},
      closeSync: (fd) => closed.push(fd),
    };
    const error = await new Promise((resolve) => helper.run(['k:108', 's:1', 'c:'], io, resolve));
    expect(error.message).toMatch(/no input device named ClickableMouse/);
    expect(closed).toEqual([7]);
  });

  it('finds devices by name prefix', () => {
    const names = helper.parseDevices(devices);
    expect(helper.findDevice(names, 'LGE RCU')).toBe('/dev/input/event0');
    expect(helper.findDevice(names, 'LGE M-RCU')).toBe('/dev/input/event3');
    expect(helper.findDevice(names, 'ClickableMouse')).toBe('/dev/input/event9');
    expect(() => helper.findDevice(names, 'Missing')).toThrow(/no input device named Missing/);
  });

  it('encodes a 32-bit and a 64-bit input_event', () => {
    const short = helper.encodeEvent(1, 108, 1, 1700000000123, 4);
    expect(short.toString('hex')).toBe('00f1536578e001000100' + '6c0001000000');
    expect(helper.encodeEvent(2, 8, -1, 0, 8)).toHaveLength(24);
    expect(helper.encodeEvent(2, 8, -1, 0, 8).readInt32LE(20)).toBe(-1);
  });

  it('frames keys, clicks, moves, and positioned wheel notches', () => {
    expect(helper.planEvents(['k:108', 'c:', 'm:3,-2', 'w:1@700,450', 's:5'])).toEqual([
      ['k', 1, 108, 1], ['k', 0, 0, 0], 50, ['k', 1, 108, 0], ['k', 0, 0, 0],
      ['c', 1, 272, 1], ['c', 0, 0, 0], 50, ['c', 1, 272, 0], ['c', 0, 0, 0],
      ['m', 2, 0, 3], ['m', 2, 1, -2], ['m', 0, 0, 0], 60,
      ['w', 3, 0, 699], ['w', 3, 1, 449], ['w', 0, 0, 0],
      ['w', 3, 0, 700], ['w', 3, 1, 450], ['w', 0, 0, 0],
      ['w', 2, 8, -1], ['w', 0, 0, 0],
      5,
    ]);
    expect(() => helper.planEvents(['x:1'])).toThrow(/bad step x:1/);
  });
});

describe('evdevBackend', () => {
  it('stops instead of steering a pointer whose position stays unknown', async () => {
    const page = { evaluate: async () => ({ x: null, y: null, visible: null }) };
    const runs = [];
    const backend = evdevBackend(page, (steps) => runs.push(steps));
    await expect(backend.move({ x: 100, y: 100 })).rejects.toThrow(/pointer position unknown/);
    expect(runs).toEqual([['m:1,0', 'm:-1,0']]);
  });
});

describe('TV wake', () => {
  const mac = '02:00:00:00:00:01';

  it('normalizes MAC addresses and rejects placeholders', () => {
    expect(normalizeMac('2-0-0-0-0-1')).toBe(mac);
    expect(normalizeMac('02:00:00:00:00:0G')).toBeNull();
    expect(normalizeMac('00:00:00:00:00:00')).toBeNull();
    expect(normalizeMac('ff:ff:ff:ff:ff:ff')).toBeNull();
  });

  it('reads the MAC for one IP from arp and ip neigh output', () => {
    const arp = '? (10.0.0.9) at 2:0:0:0:0:9 on en0 ifscope [ethernet]\n'
      + '? (10.0.0.2) at 2:0:0:0:0:1 on en0 ifscope [ethernet]\n';
    expect(parseArpMac(arp, '10.0.0.2')).toBe(mac);
    expect(parseArpMac('10.0.0.2 dev eth0 lladdr 02:00:00:00:00:01 REACHABLE', '10.0.0.2')).toBe(mac);
    expect(parseArpMac('? (10.0.0.2) at (incomplete) on en0 ifscope [ethernet]', '10.0.0.2')).toBeNull();
    expect(parseArpMac(arp, '10.0.0.20')).toBeNull();
  });

  it('builds a 102-byte magic packet', () => {
    const packet = magicPacket(mac);
    expect(packet).toHaveLength(102);
    expect([...packet.subarray(0, 6)]).toEqual([255, 255, 255, 255, 255, 255]);
    expect([...packet.subarray(96)]).toEqual([2, 0, 0, 0, 0, 1]);
    expect(() => magicPacket('nope')).toThrow(/invalid MAC/);
  });

  it('broadcasts on the subnet that holds the TV, then the limited broadcast', () => {
    const interfaces = {
      lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
      en0: [{ family: 'IPv4', address: '10.0.0.5', netmask: '255.255.255.0', internal: false }],
      en1: [{ family: 'IPv4', address: '10.1.0.5', netmask: '255.255.0.0', internal: false }],
    };
    expect(broadcastAddresses('10.0.0.2', interfaces)).toEqual(['10.0.0.255', '255.255.255.255']);
  });

  it('remembers MACs per IP in a private cache file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-wake-'));
    try {
      const file = cacheFile({ XDG_CACHE_HOME: dir });
      expect(file).toBe(join(dir, 'webos-iptv-player', 'wake.json'));
      expect(readCachedMac('10.0.0.2', file)).toBeNull();
      writeCachedMac('10.0.0.2', mac, file);
      writeCachedMac('10.0.0.3', '02:00:00:00:00:02', file);
      expect(readCachedMac('10.0.0.2', file)).toBe(mac);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        '10.0.0.2': mac, '10.0.0.3': '02:00:00:00:00:02',
      });
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const tvOutput = (addr, route) => [
    '@addr', ...addr, '@route',
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    ...route,
    '@mac', 'eth0 02:00:00:00:00:02', 'lo 00:00:00:00:00:00', 'wlan0 02:00:00:00:00:01', 'sit0 00:00:00:00',
  ].join('\r\n');
  const routes = [
    'wlan0\t00000000\t0100000A\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    'wlan0\t0000000A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
    'eth0\t0001000A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
  ];

  it('finds the TV MAC from its route table when ip and ifconfig are missing', () => {
    expect(parseTvMac(tvOutput([], routes), '10.0.0.2')).toBe(mac);
    expect(parseTvMac(tvOutput([], routes), '10.0.1.2')).toBe('02:00:00:00:00:02');
    expect(parseTvMac(tvOutput([], routes), '10.0.2.2')).toBeNull();
    expect(parseTvMac(tvOutput([], []), '10.0.0.2')).toBeNull();
    expect(parseTvMac('sh: ip: not found', '10.0.0.2')).toBeNull();
  });

  it('prefers the interface that holds the IP in ip or ifconfig output', () => {
    const ip = ['3: wlan0    inet 10.0.0.2/24 brd 10.0.0.255 scope global wlan0\\       valid_lft forever'];
    expect(parseTvMac(tvOutput(ip, []), '10.0.0.2')).toBe(mac);
    expect(parseTvMac(tvOutput(ip, []), '10.0.0.20')).toBeNull();
    const ifconfig = [
      'eth0      Link encap:Ethernet  HWaddr 02:00:00:00:00:03',
      '          inet addr:10.0.0.2  Bcast:10.0.0.255  Mask:255.255.255.0',
      '',
      'wlan0     Link encap:Ethernet  HWaddr 02:00:00:00:00:01',
    ];
    expect(parseTvMac(tvOutput(ifconfig, routes), '10.0.0.2')).toBe('02:00:00:00:00:02');
    expect(parseTvMac(['@addr', ...ifconfig].join('\n'), '10.0.0.2')).toBe('02:00:00:00:00:03');
  });

  it('asks the TV for its MAC when this computer cannot read the ARP cache', async () => {
    const written = [];
    const tvCalls = [];
    const deps = {
      probe: async () => true,
      arp: () => null,
      tv: (ip) => {
        tvCalls.push(ip);
        return parseTvMac(tvOutput([], routes), ip);
      },
      write: (ip, value) => written.push([ip, value]),
    };
    expect(await learnMac('10.0.0.2', deps)).toBe('learned');
    expect(written).toEqual([['10.0.0.2', mac]]);
    expect(await learnMac('10.0.0.2', { ...deps, arp: () => '02:00:00:00:00:09' })).toBe('learned');
    expect(tvCalls).toEqual(['10.0.0.2']);
    expect(await learnMac('10.0.0.2', { ...deps, tv: () => null })).toBe('unknown');
    expect(await learnMac('10.0.0.2', { ...deps, probe: async () => false })).toBe('asleep');
    expect(tvCalls).toEqual(['10.0.0.2']);
  });

  // ports: which of 9922/3000/3001 answer, optionally only after the packet.
  const wakeDeps = ({ before = [], after = before, cachedMac = null } = {}) => {
    const calls = { sent: 0, learned: 0, log: [] };
    let clock = 0;
    return {
      calls,
      deps: {
        ip: '10.0.0.2',
        env: {},
        probe: async (_ip, port) => (calls.sent ? after : before).includes(port),
        learn: async () => {
          calls.learned += 1;
          return 'learned';
        },
        cached: () => cachedMac,
        arp: () => null,
        send: async () => {
          calls.sent += 1;
        },
        power: async () => 'Active',
        wait: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        log: (line) => calls.log.push(line),
      },
    };
  };
  const wakeOptions = { timeout: 10, wait: true, learn: false };

  it('fails soon after a packet when the TV is on but SSH is closed', async () => {
    const { calls, deps } = wakeDeps({ before: [3001], cachedMac: mac });
    await expect(wakeTv(wakeOptions, deps)).rejects.toThrow(/TV is on but its SSH port is closed/);
    expect(calls.sent).toBe(1);
    const learnDeps = { ...deps, learn: (ip) => learnMac(ip, { probe: deps.probe, arp: () => null, tv: () => mac }) };
    await expect(wakeTv({ ...wakeOptions, learn: true }, learnDeps))
      .rejects.toThrow(/TV is on but its SSH port is closed/);
  });

  it('blames SSH, not Wake-on-LAN, when the TV wakes without SSH', async () => {
    const { calls, deps } = wakeDeps({ before: [], after: [3000], cachedMac: mac });
    await expect(wakeTv(wakeOptions, deps)).rejects.toThrow(/TV is on but its SSH port is closed/);
    expect(calls.sent).toBe(1);
  });

  it('asks to enable Wake-on-LAN when the TV never answers', async () => {
    const { deps } = wakeDeps({ cachedMac: mac });
    await expect(wakeTv(wakeOptions, deps))
      .rejects.toThrow('the TV did not answer within 10 s; check that Wake-on-LAN is enabled on the TV');
  });

  it('reuses a cached MAC for an awake TV and refreshes only on --learn', async () => {
    const awake = wakeDeps({ before: [22, 9922], cachedMac: mac });
    await wakeTv(wakeOptions, awake.deps);
    expect(awake.calls).toMatchObject({ sent: 1, learned: 0, log: ['TV is already awake'] });
    await wakeTv({ ...wakeOptions, learn: true }, awake.deps);
    expect(awake.calls.learned).toBe(1);
    const woken = wakeDeps({ after: [9922], cachedMac: mac });
    await wakeTv(wakeOptions, woken.deps);
    expect(woken.calls).toMatchObject({ sent: 1, learned: 0 });
    const unknown = wakeDeps({ before: [9922] });
    await wakeTv(wakeOptions, unknown.deps);
    expect(unknown.calls.learned).toBe(1);
  });
});
