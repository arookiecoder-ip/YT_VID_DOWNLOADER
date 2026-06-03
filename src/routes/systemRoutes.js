const express = require("express");
const { createSystemController } = require("../controllers/systemController");

function createSystemRoutes(dependencies) {
  const router = express.Router();
  const controller = createSystemController(dependencies);

  router.get("/health", controller.health);
  router.get("/version", controller.version);

  return router;
}

module.exports = { createSystemRoutes };
