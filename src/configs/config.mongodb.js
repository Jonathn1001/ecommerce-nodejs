"use strict";

const dev = {
  app: {
    port: process.env.DEV_APP_PORT,
    api_version: process.env.DEV_API_VERSION,
  },
  db: {
    host: process.env.DEV_DB_HOST,
    port: process.env.DEV_DB_PORT,
    name: process.env.DEV_DB_NAME,
  },
};

const ci = {
  app: {
    port: process.env.CI_APP_PORT,
    api_version: process.env.CI_API_VERSION,
  },
  db: {
    host: process.env.CI_DB_HOST,
    port: process.env.CI_DB_PORT,
    name: process.env.CI_DB_NAME,
  },
};

const config = { dev, ci };
const env = process.env.NODE_ENV || "dev";

module.exports = config[env];
