"use strict";

const Resource = require("../models/resource.model");
const Role = require("../models/role.model");

/**
 * TODO: Create a new resource
 * @param {string} name
 * @param {string} slug
 * @param {string} description
 * @returns
 */
const createResource = async ({ name, slug, description }) => {
  try {
    // ? 1.Check if the resource already exists
    if (!name || !slug) {
      throw new Error("name and slug are required");
    }
    // ? 2. Create the resource
    return await Resource.create({
      src_name: name,
      src_slug: slug,
      src_description: description,
    });
  } catch (error) {
    throw new Error(error);
  }
};

/**
 * TODO: Get list of resources
 * @param {string} userID
 * @param {number} limit
 * @param {number} page
 * @param {string} sort
 * @param {string} order
 * @returns
 */
const getResources = async ({
  userID,
  limit = 10,
  page = 1,
  sort = "createdAt",
  order = "desc",
}) => {
  try {
    //? 1. Check role of the user
    //? 2. Get all resources
    return await Resource.aggregate([
      {
        $project: {
          _id: 0,
          name: "$src_name",
          slug: "$src_slug",
          description: "$src_description",
          resource_id: "$_id",
          createdAt: 1,
        },
      },
    ]);
  } catch (error) {
    throw new Error(error);
  }
};

/**
 * TODO: Create a new role
 * @param {string} name
 * @param {string} slug
 * @param {string} description
 * @param {array} grants
 * @returns
 */
const createRole = async ({
  name = "",
  slug = "",
  description = "",
  grants = [],
}) => {
  try {
    // ? 1. Check if the role already exists
    if (!name || !slug) throw new Error("name and slug are required");
    // ? 2. Create the role
    return await Role.create({
      rol_name: name,
      rol_slug: slug,
      rol_description: description,
      rol_grants: grants,
    });
  } catch (error) {
    throw new Error(error);
  }
};
/**
 * TODO: Get list of roles
 * @param {string} userID
 * @param {number} limit
 * @param {number} page
 * @param {string} sort
 * @param {string} order
 * @returns
 */
const getRoles = async () => {
  try {
    // ? 1. Get all roles
    return await Role.aggregate([
      {
        $unwind: "$rol_grants",
      },
      {
        $lookup: {
          from: "resources",
          localField: "rol_grants.resource",
          foreignField: "_id",
          as: "resource",
        },
      },
      {
        $unwind: "$resource",
      },
      {
        $project: {
          _id: 0,
          name: "$rol_name",
          resource: "$resource.src_name",
          actions: "$rol_grants.actions",
          attributes: "$rol_grants.attributes",
        },
      },
      {
        $unwind: "$actions",
      },
      {
        $project: {
          role: 1,
          resource: 1,
          action: "$actions",
          attributes: 1,
        },
      },
    ]);
  } catch (error) {
    throw new Error(error);
  }
};

module.exports = {
  createResource,
  getResources,
  createRole,
  getRoles,
};
