module.exports = {
  apps: [
    {
      name: 'wa-gateway',
      script: 'dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      // Restart on crash with exponential back-off
      restart_delay: 3000,
      max_restarts: 10,
      // Log config — minimal disk writes for STB eMMC health
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
    },
  ],
}
