const express = require("express");
const { createViewController } = require("../controllers/viewController");

function createViewRoutes(dependencies) {
  const router = express.Router();
  const controller = createViewController(dependencies);

  router.get("/{*splat}", controller.index);

  return router;
}

module.exports = { createViewRoutes };
