"use strict";

const templateModel = require("../models/template.model");
const { BadRequestError } = require("../utils/AppError");

const getTemplate = async ({ name = "" }) => {
  // ? 1. Check if the template already exists
  return await templateModel.findOne({ template_name: name }).lean();
};

const newTemplate = async ({ name = "", content = "" }) => {
  // ? 1. Check if the template already exists
  const template = await getTemplate({ name });
  // ? 2. If the template exists
  if (template) return BadRequestError("Template already exists");
  // ? 3. If the template does not exist, create a new template
  const newTemplate = await templateModel.create({
    template_name: name,
    template_html: content,
  });
  return newTemplate;
};

module.exports = { newTemplate, getTemplate };
