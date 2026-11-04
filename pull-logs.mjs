import { Client } from 'ssh2';

const conn = new Client();

conn
  .on('ready', () => {
    console.log('SSH connected');
    // Try multiple log sources
    const commands = [
      'tv.sh diag 2>&1 | head -200',
      'journalctl --no-pager -n 100 2>&1',
      'ls /var/log/ 2>&1',
      'cat /var/log/messages 2>&1 | head -100',
      'ps aux | grep -i iptv 2>&1',
    ];
    let completed = 0;
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
    privateKey: require('fs').readFileSync(require('os').homedir() + '/.ssh/lg-65-tv_webos'),
    passphrase: 'D52633',
    readyTimeout: 10000,
    algorithms: {
      hostKey: ['ssh-rsa'],
    },
  });
