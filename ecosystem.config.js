module.exports = {
  apps: [
    {
      name: "rep-tracker",
      script: "server.js",
      cwd: __dirname
    },
    {
      name: "tunnel",
      script: "C:/Users/User/ngrok-bin/ngrok.exe",
      args: ["http", "--url", "coliseum-waking-escapable.ngrok-free.dev", "3000"],
      interpreter: "none"
    }
  ]
};
