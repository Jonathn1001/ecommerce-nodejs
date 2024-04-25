"use strict";

const _ = require("lodash");

const getInfoData = ({ fields = [], obj = {} }) => {
  return _.pick(obj, fields);
};

module.exports = {
  getInfoData,
};
