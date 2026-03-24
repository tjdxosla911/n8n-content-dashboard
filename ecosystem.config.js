module.exports = {
  apps: [{
    name: 'dashboard',
    script: '/opt/dashboard/app.js',
    cwd: '/opt/dashboard',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      N8N_APPROVE_WEBHOOK: 'https://n8n.bestrealinfo.com/webhook/content-approve',
    },
    error_file: '/opt/dashboard/logs/error.log',
    out_file:   '/opt/dashboard/logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
