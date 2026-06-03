const path = require("path");

function createViewController({ publicDir }) {
  function index(req, res) {
    res.sendFile(path.join(publicDir, "index.html"));
  }

  return { index };
}

module.exports = { createViewController };
