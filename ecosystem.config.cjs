// pm2 process file. Start with: pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'draw',
      script: 'dist/server/index.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 3210,
        DB_PATH: './data/canvas.db',
      },
      max_memory_restart: '768M',
      kill_timeout: 5000,
      time: true,
    },
  ],
};
