const { Client } = require('ssh2');
const fs = require('fs');
const os = require('os');

const conn = new Client();

const commands = [
  'ps aux 2>&1',
  'ls /tmp/ 2>&1',
  'ls /media/developer/ 2>&1',
  'find / -maxdepth 3 -name "*.log" 2>/dev/null',
  'find / -maxdepth 3 -name "*iptv*" 2>/dev/null',
  'ls -la /proc/2678/fd/ 2>&1',
  'cat /proc/2678/cmdline 2>/dev/null | tr "\\0" " "',
  'ls /var/ 2>&1',
  'ls /run/ 2>&1',
];

let completed = 0;
conn
  .on('ready', () => {
    console.log('SSH connected');
    commands.forEach((cmd, idx) => {
      conn.exec(cmd, (err, stream) => {
        if (err) {
          console.log(`\n=== CMD ${idx + 1}: ${cmd} ===`);
          console.log('ERROR:', err.message);
          completed++;
          if (completed === commands.length) conn.end();
          return;
        }
        let output = '';
        stream.on('data', (data) => { output += data.toString(); });
        stream.on('close', (code) => {
          console.log(`\n=== CMD ${idx + 1}: ${cmd} (exit ${code}) ===`);
          console.log(output || '(no output)');
          completed++;
          if (completed === commands.length) conn.end();
        });
      });
    });
  })
  .on('error', (err) => {
    console.error('SSH error:', err.message);
  })
  .connect({
    host: '192.168.1.123',
    port: 9922,
    username: 'prisoner',
    privateKey: fs.readFileSync(os.homedir() + '/.ssh/lg-65-tv_webos'),
    passphrase: 'D52633',
    readyTimeout: 10000,
    algorithms: {
      hostKey: ['ssh-rsa'],
    },
  });
