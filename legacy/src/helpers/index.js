"use strict";

// * Wrapper function to catch errors in async functions
const catchAsync = (fn) => (req, res, next) => {
  fn(req, res, next).catch(next);
};

module.exports = {
  catchAsync,
};
