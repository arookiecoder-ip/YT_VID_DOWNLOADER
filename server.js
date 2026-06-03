const { app } = require("./src/app");
const { PORT, BIND_HOST } = require("./src/config/env");

function startServer(port = PORT) {
  return app.listen(port, BIND_HOST, () => {
    console.log("\n  TubeGrab running at http://" + BIND_HOST + ":" + port + "\n");
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  ...require("./src/app"),
};
