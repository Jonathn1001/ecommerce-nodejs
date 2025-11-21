"use strict";

const express = require("express");
const rbacController = require("../../controller/rbac.controller");
const { apiKey, authentication } = require("../../auth/checkAuth");
const router = express.Router();

router.use(apiKey);
router.use(authentication);

router.post("/role/create", rbacController.createRole);
router.get("/role/list", rbacController.getRoleList);

router.post("/resource/create", rbacController.createResource);
router.get("/resource/list", rbacController.getResourceList);

module.exports = router;
