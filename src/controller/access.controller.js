"use strict";

const AccessService = require("../services/access.service");

class AccessController {
  signUp = async (req, res) => {
    try {
      console.log(`[P]::signUp::req.body`, req.body);
      return res.status(201).json(await AccessService.signUp(req.body));
    } catch (error) {
      next(error);
    }
  };
}

module.exports = new AccessController();
