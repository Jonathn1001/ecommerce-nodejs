"use strict";
const statusCodes = require("../constants/statusCodes");
const reasonPhrases = require("../constants/reasonPhrases");

class SuccessResponse {
  constructor({
    message,
    statusCode = statusCodes.OK,
    reason = reasonPhrases.OK,
    metadata = {},
  }) {
    this.message = message ? message : reason;
    this.status = statusCode;
    this.metadata = metadata;
  }

  send(res, header = {}) {
    return res.status(this.status).json(this);
  }
}

class OK extends SuccessResponse {
  constructor({ message, metadata }) {
    super({ message, metadata });
  }
}

class CREATED extends SuccessResponse {
  constructor({ message, metadata }) {
    super({ message, statusCode: statusCodes.CREATED, metadata });
  }
}

module.exports = {
  OK,
  CREATED,
  SuccessResponse,
};
