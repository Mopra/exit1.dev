module.exports = {
  apps: [{
    name: 'exit1-vps-runner',
    script: 'lib/runner.js',
    cwd: '/opt/exit1/repo/vps',
    instances: 1,
    autorestart: true,
    max_restarts: 50,
    min_uptime: '10s',
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production'
    },
    // Log rotation
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/var/log/exit1/error.log',
    out_file: '/var/log/exit1/out.log',
    merge_logs: true,
    // Graceful shutdown
    kill_timeout: 30000,
    listen_timeout: 10000,
  }]
};
