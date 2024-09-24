"use strict";

const { Types } = require("mongoose");
const _ = require("lodash");

const convertToObjectId = (id) => {
  return new Types.ObjectId(id);
};

const getInfoData = ({ fields = [], obj = {} }) => {
  return _.pick(obj, fields);
};

// ? ['a', 'b'] => {a: 1, b: 1}
const getSelectData = (select = []) => {
  return Object.fromEntries(select.map((item) => [item, 1]));
};

// ? ['a', 'b'] => {a: 0, b: 0}
const getUnSelectData = (unselect = []) => {
  return Object.fromEntries(unselect.map((item) => [item, 0]));
};

// ? Remove null or undefined properties
const removeEmpty = (obj = {}) => {
  if (!_.isObject(obj)) return obj;
  return _.pickBy(obj, _.identity);
};

// ? Convert object to array
const convertToArray = (obj = {}) => {
  return Object.keys(obj).map((key) => obj[key]);
};
// ? Count appearances of a value in an array
const countAppearances = (arr = [], value) => {
  return arr.reduce((acc, item) => (item === value ? acc + 1 : acc), 0);
};

module.exports = {
  getInfoData,
  getSelectData,
  getUnSelectData,
  removeEmpty,
  convertToObjectId,
  convertToArray,
  countAppearances,
};
