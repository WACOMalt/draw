// pm2 process file. Start with: pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'draw',
      script: 'dist/server/index.js',
      // Node binary for this app only. It must match the Node that built better-sqlite3.
      // On potato-vps1 the deploy script sets DRAW_NODE=/usr/local/bin/node (Node 24).
      interpreter: process.env.DRAW_NODE || 'node',
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
